<!-- Source research for the adopted Staro Trnje–Savica UPU and its implementation evidence. -->
# Official Staro Trnje-Savica UPU source package

## What is the adopted source, what does it contain, and is it current?

### Takeaway

The concrete source is a 2012 adopted UPU, listed by the City as an adopted plan and as a currently valid spatial plan. Its authoritative package is not one map: the City page links the adoption decision and an eight-sheet 1:1,000 cartographic bundle, while the decision defines the textual provisions and the drawings as one elaborat.

### Cited Findings

- The City’s plan page names the plan, identifies it as `SGGZ 6/12`, and separates the adopted decision from the adopted cartographic displays. [City plan page](https://zagreb.hr/urbanisticki-plan-ure%C4%91enja-staro-trnje-savica-za-z/89119)
- The City’s current adopted-UPU index continues to list this plan as `SGGZ 6/12`; the City’s current valid-plan register lists the same plan only as `6/2012`. This supports treating 6/12 as the current published edition, but the list itself is not a proof that no later legal act exists. [City adopted-UPU index](https://zagreb.hr/urbanisticki-planovi-ure%C4%91enja-upu-doneseni/89072); [City valid-plan register](https://zagreb.hr/vazeci-prostorni-planovi/60656)
- The adoption decision says the plan covers about 36.5 ha and gives its four boundary references: Slavonska Avenue, Av. V. Holjevca, the planned north-south road east of Lastovska/Prisavlje, and the planned extended Prisavlje regulation line. [Decision, Art. 2](https://informator.hr/zakoni/559891-odluka-o-donosenju-urbanistickog-plana-uredenja-staro-trnje-savica-za-zonu-prisavlje-ulica-v-ruzdjaka-planirana-strojarska?v=572009)
- Article 4 makes the text, general attachments, eight 1:1,000 drawings, explanation, GUP extract and adoption record one plan elaborat. The drawing set is existing state; land use; transport; existing and planned infrastructure; conditions/protection; manner and conditions of construction; and urban-planning procedures. [Decision, Art. 4](https://informator.hr/zakoni/559891-odluka-o-donosenju-urbanistickog-plana-uredenja-staro-trnje-savica-za-zonu-prisavlje-ulica-v-ruzdjaka-planirana-strojarska?v=572009); [official eight-sheet PDF](https://www.zagreb.hr/userdocsimages/arhiva/prostorni_planovi/upu%20staro%20trnje/UPU%20Staro%20Trnje_svi%20listovi.pdf)
- The City’s plan-GIS catalogue calls the City publisher’s planned-land-use geometry a primary source, but explicitly records unknown reuse licence and unknown retention. It is useful corroborating/source-discovery data, not a licence grant or a substitute for the sealed UPU drawings. [Catalogue record](https://zagreb.lol/izvori-podataka/sources/city-zagreb-gup-plans.html)

### Inferences

- An import must freeze an edition record with the decision, each drawing, source URL, retrieval date and file checksum; it must never overwrite this UPU geometry with a later GUP service response.
- The current-plan claim should be a validated `published-register` status with an observation date, rather than an eternal boolean. A later amendment or a decision to put the UPU out of force must create a successor or status event.

### Gaps

- The official adoption-decision deep link currently redirects to the City’s replacement Službeni glasnik landing page in automated retrieval. The City still identifies it as the official adopted decision, but an ingestion run should preserve a downloaded official copy/checksum and record that retrieval limitation.
- I found no City-published vector dataset for the 2012 UPU itself. The official graphic is a PDF; any digitized polygons need a `derived-from-drawing` provenance rather than a claim of official vector geometry.

## Which actual rules and spatial objects can form permitted inputs?

### Takeaway

The plan already has a highly usable rule architecture: named `kazete` (planning cells), use polygons, regulatory/building lines, transport corridors, procedures, numeric coverage/FAR/storey limits and use quotas. But its unit of regulation is usually the *planned building plot or cell*, not the current cadastral parcel.

### Cited Findings

- Article 5 says public and other land uses are determined and delimited by colour and plan sign on drawing 1. It defines at least M1, M2 and D categories. [Decision, Art. 5](https://informator.hr/zakoni/559891-odluka-o-donosenju-urbanistickog-plana-uredenja-staro-trnje-savica-za-zonu-prisavlje-ulica-v-ruzdjaka-planirana-strojarska?v=572009)
- Article 46 defines `kig` as footprint-to-building-plot ratio, `kis` as gross developed area-to-building-plot ratio, and `kisn` as above-ground GBP-to-building-plot ratio. Its new-construction table is keyed by named cells, not cadastral parcel ids: for example C-15 is M1, 5,647 m², 11,294 m² GBP, `kig` 0.5, `kisn` 2.0, 4 storeys; C-7 is M1, 2,211 m², `kig` 0.5, `kisn` 1.5, 3 storeys. [Decision, Art. 46](https://informator.hr/zakoni/559891-odluka-o-donosenju-urbanistickog-plana-uredenja-staro-trnje-savica-za-zonu-prisavlje-ulica-v-ruzdjaka-planirana-strojarska?v=572009)
- The same table subtracts planned parks and public/social land from some cells before calculating the development area: C-1, C-2, C-3 and C-5 each have named deductions. It also says the total `kis` is not set because multiple underground storeys may be built, while `kisn` is based on above-ground GBP. [Decision, Art. 46 notes](https://informator.hr/zakoni/559891-odluka-o-donosenju-urbanistickog-plana-uredenja-staro-trnje-savica-za-zonu-prisavlje-ulica-v-ruzdjaka-planirana-strojarska?v=572009)
- Article 26 demonstrates that a cell may itself be the building plot: A-2/A-3/A-4 have a height limit stated as “podrum i 4 etaže” (basement and four storeys), `kig` 0.5, `kisn` 2.0 and at least 20% natural terrain; the building-plot area is identical to the cell except separate infrastructure plots. It also requires an urban-architectural competition. [Decision, Art. 26](https://informator.hr/zakoni/559891-odluka-o-donosenju-urbanistickog-plana-ure%C4%91enja-staro-trnje-savica-za-zonu-prisavlje-ulica-v-ruzdjaka-planirana-strojarska?v=572009)
- C-2 demonstrates an unresolved lower-tier dependency: its minimum individual building-plot size is to be determined by a detailed plan, while it requires a kindergarten (at least 3,500 m²), park (at least 1,800 m²), pedestrian continuity, a height limit stated as “podrum i 4 etaže”, `kig` 0.5, `kisn` 2.0 and 20% natural terrain. [Decision, Art. 39](https://informator.hr/zakoni/559891-odluka-o-donosenju-urbanistickog-plana-ure%C4%91enja-staro-trnje-savica-za-zonu-prisavlje-ulica-v-ruzdjaka-planirana-strojarska?v=572009)
- C-16 is a practical confirmation that drawings contain decisive geometry: a 2019 permit describes a newly formed parcel from parts of two earlier cadastral parcels, within C-16, and says the UPU drawing specifies regulatory line, building line, their distance and maximum four above-ground storeys. [City building permit](https://www.zagreb.hr/userdocsimages/arhiva/prostorno_uredjenje/GD%2019%20-%202377.pdf)
- Article 36 makes drawing 4.1 decisive for building lines, regulatory lines, their minimum separation and distance to cadastral land outside the UPU. It also says not every location has a drawn building line; the outer street regulation line is normally the building line unless a drawing says otherwise. [Decision, Art. 36](https://informator.hr/zakoni/559891-odluka-o-donosenju-urbanistickog-plana-uredenja-staro-trnje-savica-za-zonu-prisavlje-ulica-v-ruzdjaka-planirana-strojarska?v=572009)
- The permit’s quotation of Article 44 shows the cell-level rule bundle: independent, semi-attached or attached buildings; 600 m² minimum building plot; a height limit stated as “podrum i 4 etaže”; `kig` 0.5; `kisn` 2.0; 3 m or half-height boundary distance depending on type; 5% of residential GBP as open building parts; and 20% natural terrain. The permit’s approved design explicitly has one underground plus four above-ground storeys, so the system should record the source’s `4E` rather than invent `P+4`. [City building permit, pp. 3-4](https://www.zagreb.hr/userdocsimages/arhiva/prostorno_uredjenje/GD%2019%20-%202377.pdf)
- M2 cells cap residential GBP at 30% per cell, and M1 caps business GBP at 30% of the total above-ground GBP within the plan area; parking has use-dependent standards and is ordinarily required on the development plot. [Decision, Arts. 25 and 49](https://informator.hr/zakoni/559891-odluka-o-donosenju-urbanistickog-plana-uredenja-staro-trnje-savica-za-zonu-prisavlje-ulica-v-ruzdjaka-planirana-strojarska?v=572009)

### Inferences

- The source adapter should create distinct feature families: `plan_extent`, `kazeta`, `land_use`, `public_dedication`, `street_or_corridor`, `regulation_line`, `building_line`, `procedure_area`, and a ruleset scoped to each feature. It should not flatten those into one zoning polygon.
- A solver-ready rule needs field-level semantics: denominator (`building_plot`, `cell net of dedications`, or plan area), vertical reference (`above_ground` versus all GBP), minimum/maximum/exact/operator, and a citation to both article/table cell and drawing.
- The source must also preserve conditions that alter the calculation: whether a building plot can be the whole cell, its lower/upper size, whether a DPU or competition must first determine it, and whether the relevant line was drawn or is a textual default.
- For C-16, a derived permitted item could be calculated only after a current/buildable plot is identified and clipped to the cell’s building/regulatory geometry. It must retain the remaining uncertainty about the official line geometry and any permit-specific confirmation.

### Gaps

- The PDF is a 1:1,000 cartographic publication, so it displays building/regulatory lines and cells but provides no observed coordinate accuracy or machine-readable topology. Georeferencing error and line interpretation must be recorded per derived feature.
- Textual provisions include procedural gates (competition/DPU) and qualitative rules; these cannot truthfully become an unconditional maximum build-out merely because numeric caps exist.

## What proves the cadastral-boundary and versioning problem in this case?

### Takeaway

This UPU is direct evidence that parcels cannot be the sole planning identity. The plan uses planned cells and future building plots; later land-registry/cadastral actions split and assemble land. A permitted layer must therefore distinguish the plan’s development unit from every contemporaneous cadastral parcel that intersects it.

### Cited Findings

- The plan says its land-use boundaries are shown on the use drawing, while numeric rules repeatedly use `građevna čestica` and sometimes explicitly say the building plot is the whole cell or will be fixed by a later detailed plan. [Decision, Arts. 5, 26, 39 and 46](https://informator.hr/zakoni/559891-odluka-o-donosenju-urbanistickog-plana-uredenja-staro-trnje-savica-za-zonu-prisavlje-ulica-v-ruzdjaka-planirana-strojarska?v=572009)
- A City permit records a buildable parcel 3027/2 created from parts of parcels 3028/1 and 3027, rather than treating either former cadastral parcel as the plan’s enduring development unit. [City building permit](https://www.zagreb.hr/userdocsimages/arhiva/prostorno_uredjenje/GD%2019%20-%202377.pdf)
- A 2021 City assembly attachment overlays the UPU with then-current registry/cadastre and records a 2,412 m² newly formed land-registry parcel 3011/4 plus a 96 m² parcel 3012/2. It explicitly says its overlay follows survey report RN 89/2020. [City assembly attachment](https://web.zagreb.hr/Sjednice/2021/sjednice_skupstine_2021.nsf/0/C12586DF003A998EC125878D00664FF7/%24FILE/04%2BPrilog%2B-.pdf)
- The 2021 attachment also quotes the UPU for a portion of parcel 3012: it lies in C-15, M1/new construction, outside planned infrastructure surfaces and outside competition/DPU areas. This is a specific example of an intersecting cadastral fragment being assessed by plan cell, drawing type and procedure area together. [City assembly attachment](https://web.zagreb.hr/Sjednice/2021/sjednice_skupstine_2021.nsf/0/C12586DF003A998EC125878D00664FF7/%24FILE/04%2BPrilog%2B-.pdf)
- Some cells are maintenance-only: B-4, C-17 and C-19 retain existing height, plot, coverage, `kig`, `kisn` and natural-terrain parameters and prohibit an increase during replacement/reconstruction. [Decision, Art. 45](https://informator.hr/zakoni/559891-odluka-o-donosenju-urbanistickog-plana-uredenja-staro-trnje-savica-za-zonu-prisavlje-ulica-v-ruzdjaka-planirana-strojarska?v=572009)

### Inferences

- Model two geometries and identities: an immutable `plan_unit` (cell/line/public-dedication/procedure feature in its plan edition) and a time-stamped `cadastral_relation` that records intersection, containment, and source date. A cell can correspond to many parcels and a parcel can cross several plan features.
- Do not calculate one independent envelope per parcel where a rule’s denominator or mandatory public land applies to a whole cell. Return `requires_land_assembly` or `shared_cell_allocation_unknown` until the system has a recorded building-plot/land-readjustment allocation.
- Where a boundary cuts a current parcel, return per-intersection components with their areas and rules, then classify: (1) fully buildable component, (2) public dedication/corridor, (3) no-new-build/maintenance, (4) procedural gate, or (5) unresolved line accuracy. Combining components into one envelope needs an explicit legal/physical-contiguity rule, not a geometry union by default.

### Gaps

- The 2021 overlay is evidence of a particular later cadastral state, not a current cadastre feed and not a complete parcel-to-cell concordance for 36.5 ha.
- I found no adopted amendment or repeal in the City’s current registers, but this must be rechecked on each import/update; lack of a listed amendment is not enough to infer no later site-specific act, permit, DPU or competition outcome.
