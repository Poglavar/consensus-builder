<!-- Research on versioning, spatial scope and typed constraints for UPU integration. -->
# UPU permitted-layer architecture

## What must be versioned and how should overlapping plans resolve?

### Takeaway
Treat an adopted plan edition as an immutable, source-backed input manifest, and an evaluation as a separate immutable calculation over that edition. Do not use a single “current layer” or a generic last-drawn-wins stack: applicability and supersession must be explicit for each feature and constraint.

### Cited Findings
- Croatian spatial plans are by law a complete document of implementing provisions, cartographic displays and explanatory material; they have the legal nature of a by-law. [Spatial Planning Act, arts. 78 and 82](https://narodne-novine.nn.hr/clanci/sluzbeni/full/2025_12_155_2315.html)
- The current Act distinguishes local plans including GUP and UPU, requires a lower-level plan to conform with the higher-level plan, and requires a narrower-area plan at the same level to conform with the wider-area plan. [Spatial Planning Act, arts. 84–85](https://narodne-novine.nn.hr/clanci/sluzbeni/full/2025_12_155_2315.html)
- The Act says plans prescribe conditions according to their level and scope, while an area for which the broader plan prescribes guidelines for a narrower plan is an exception; therefore geometry overlap alone cannot prove which rule is effective. [Spatial Planning Act, art. 77](https://narodne-novine.nn.hr/clanci/sluzbeni/full/2025_12_155_2315.html)
- The existing scenario design already identifies that the official tables have incompatible revision conventions and says an immutable plan definition must pin source text, structured rules, area assignments, land use, exceptions, UPU/special regimes, planned lines/corridors and global policies. [Existing scenario design](../../gup-scenario-integration.md#L115)
- The existing plan-file schema only persists selected planning-source/scenario settings, rather than an official rule edition or an evaluation identity. [Plan-file schema](../../../frontend/schemas/plan-file-v1.schema.json#L136)
- The current runtime’s viewport result cache is keyed by city, source, scenario and bbox, while current permitted items are per source parcel. [Envelope loader](../../../backend/planning/parcel-envelopes.js#L188); [permitted-plan design](../../permitted-plan-parcels.md#L38)

### Inferences
- Create four distinct records, rather than making a UPU another value in `planningScenario`:
  1. **`plan_edition`**: stable authority/plan identity plus adoption/publication/validity facts and a content hash of each official artefact (decision, consolidated provisions, map sheet, legend and any authoritative vector/raster). It never changes.
  2. **`plan_feature`**: a versioned extracted feature with geometry, feature type (`scope`, `land_use`, `urban_rule_area`, `building_line`, `regulation_line`, `infrastructure`, `protection`, `planned_construction_lot`), source locator/page/layer, digitisation method and geometric confidence. A feature’s extracted geometry is evidence, not a new legal boundary.
  3. **`constraint`**: a typed rule atom linked to its exact Croatian provision and feature scope, with applicability, value/unit/reference/denominator and a support state. Preserve unmodelled prose as evidence.
  4. **`evaluation`**: an immutable selection of editions, an explicit composition policy, cadastral/context snapshot, evaluator build and results. A re-run is a different evaluation, never an implicit amendment.
- Model relationships as explicit `applies_within`, `supersedes`, `narrows`, `excepts`, `requires_joint_reading` and `conflicts_with`; require every relation to name its evidence. Do not infer `supersedes` solely from adoption date, scale, or polygon containment.
- Resolve effective constraints per quantity, not per “winning layer.” For example a UPU building line can govern siting while GUP constraints remain relevant where the UPU does not expressly replace height, land use, access or protection rules. The result should report each selected constraint, all candidate constraints, the resolution rule and the exact citations.
- Use a three-valued outcome for every constraint and output: **supported/pass-or-fail**, **not applicable**, or **unknown/unsupported/conflicting**. “No envelope” must not silently mean “prohibited.” This matches the present evaluator’s explicit unavailable reasons and unresolved checks. [Envelope tests](../../../backend/test/planning-parcel-envelopes.test.js#L138); [assessment model](../../../frontend/js/planning/parcel-assessment.js#L257)
- A bounded first release can admit one named UPU edition plus one pinned GUP edition for a fixed UPU boundary. It should reject a second UPU, amendment or special overlay unless an editor records a source-backed composition decision. That is safer and more useful than pretending to solve all citywide overlap immediately.

### Gaps
- The legal source establishes hierarchy and content, but it does not supply one generic machine-executable precedence algorithm for every mixed GUP/UPU provision. The specific adopted UPU’s provisions and map legend must decide which quantities it actually regulates.
- Whether the City publishes a legally authoritative vector package for the selected legacy UPU remains a source-discovery question; scanned/raster drawings need a recorded georeferencing and extraction confidence rather than fabricated precision.

## How should a rule boundary that cuts a cadastral parcel be evaluated?

### Takeaway
Keep planning areas, existing cadastral parcels, and planned construction lots as separate geometries. Intersections are evidence for rule resolution and placement masks; they do not create new parcels or automatically become the denominator for KIG, KIS, dwelling caps, frontage, minimum area or setbacks.

### Cited Findings
- GUP 2025 Article 23(11) provides a specific majority-area rule for a building plot covered by more than one urban rule; Article 23 also addresses map/cadastre misalignment and mixed-use plot formation. [Official GUP 2025, Article 23](https://www.zagreb.hr/userdocsimages/arhiva/prostorni_planovi/izid%20gup%20grada%20zagreba_2023-/gup_2025_donesen%20plan/GUP%20GZ%20-%20pro%C4%8Di%C5%A1%C4%87eni%20tekst%202025%20%281%29.pdf#page=31)
- The existing scenario design consequently says to preserve the distinction between cadastral parcel, building plot and planning-zone intersection; a fragment is not a new solver parcel or an independent denominator for KIS/KIG/unit caps. [Existing scenario design](../../gup-scenario-integration.md#L182)
- Current viewport work reads zoning over whole parcel outlines, records other-zone coverage, and either emits one item per substantial zoning partition or retains a minor crossing as evidence. [Envelope loader](../../../backend/planning/parcel-envelopes.js#L220); [regression tests](../../../backend/test/planning-parcel-envelopes.test.js#L166)
- The existing plan-created-plot design separately identifies client-authored/live plan pieces and retains source cadastral IDs as provenance; it labels a Zagreb geometry solve as a hypothetical plot, outside the citywide existing-cadastre evaluation. [Permitted plan parcels](../../permitted-plan-parcels.md#L84); [Zagreb plot path](../../permitted-plan-parcels.md#L168)

### Inferences
- Store an `intersection_evidence` record for each evaluation candidate: `parcel_snapshot_id`, `feature_id`, full intersection geometry/area/share, precision/registration metadata, and the source geometries. This makes a boundary decision inspectable without converting the intersection into a cadastral object.
- Give each constraint an explicit **subject** and **denominator**. Useful subjects are `existing_cadastral_parcel`, `lawful_building_plot`, `planned_construction_lot`, `building_footprint`, `buildable_polygon`, `building`, `street_frontage`, and `plan_area`. Useful denominator values are `whole_subject`, `named_planned_lot`, `intersection_fragment`, or a source-defined area. A rule can use a fragment for a siting mask but the whole building plot for KIG only when its source says so.
- Use a `geometry_effect` that is independent of the numeric rule: `mask` (building must stay inside/outside), `line_max`, `line_required`, `corridor/reservation`, `area_classification`, or `evidence_only`. This prevents a line or protection area from being incorrectly converted into a land-use zone.
- For a verified UPU provision that itself defines a planned construction lot, use that **named UPU lot** as the subject only after recording its plan identity and relationship to the cadastre. It is not a hypothetical union of whichever fragments look compatible. If the UPU does not establish that lot or its relationship cannot be verified, evaluate the existing cadastral parcel and return `unknown` for any rule requiring a construction-lot denominator.
- For a GUP-only majority rule, calculate shares over the legally applicable subject and show the shares/citations. For a UPU, never carry that tie-break rule over by intuition: first search the UPU text/map for its own boundary or plot-formation provision. If none has been formalised, show competing constraints and mark the applicable numeric result unresolved.
- Example (hypothetical): a 900 m² cadastral parcel crosses a UPU `D` corridor by 80 m² and a building line cuts another 120 m². The corridor and line may reduce the placement mask, but a `KIG=0.30` cannot be calculated as 0.30 × 700 m² unless the cited provision says the 700 m² remainder is the construction-lot denominator. The system should show a mask and `denominator-unresolved`, not an apparently authoritative 210 m² footprint.

### Gaps
- The final legal subject for an individual parcel may depend on a lawful `građevna čestica` formation or a permit-stage interpretation that the source map alone cannot establish. The permitted layer should not infer formation from geometry.
- Raster-line location, cadastral revision date and georeferencing error need a source-specific tolerance policy. Until it exists, retain raw intersections and communicate uncertainty rather than snapping/absorbing slivers.

## Which rule language and delivery sequence make the system extensible without overstating interpretation?

### Takeaway
Translate only the small, evidenced subset of a UPU into typed constraints and geometry effects, while retaining every original citation and exposing unsupported rules. Add rule types through a registry with declared evaluator support; do not use a free-text/LLM parse as permission to compute capacity.

### Cited Findings
- Croatia’s current plan rulebook requires construction-area plan content to include measures such as maximum coverage `kig`, floor-area ratio `kis`, gross floor area, façade/total height and storeys; its layer rules place plan provisions in cartographic/attribute-table form. [Pravilnik o prostornim planovima](https://narodne-novine.nn.hr/clanci/sluzbeni/2023_12_152_2228.html)
- The Act describes planning conditions as extending beyond numeric building controls to land-use delimitations, infrastructure regimes, protection and other measures. [Spatial Planning Act, art. 78](https://narodne-novine.nn.hr/clanci/sluzbeni/full/2025_12_155_2315.html)
- The current evaluator already operates on typed constraint quantities such as setbacks, height, lot area and coverage, and preserves direct/evidence status instead of deriving an envelope from an estimated height. [Evaluator](../../../backend/planning/parcel-envelopes.js#L35); [tests](../../../backend/test/planning-parcel-envelopes.test.js#L138)
- The existing scenario proposal explicitly says unmodelled provisions should remain source evidence rather than be presented as executable, and that selected evaluations must pin source/context/solver inputs. [Existing scenario design](../../gup-scenario-integration.md#L129)
- Existing human-visible permitted controls and MCP building operations both use the same planning-envelope output, but the documented MCP route currently cannot address live `#` plan pieces. [MCP parity inventory](../../permitted-plan-parcels.md#L74)

### Inferences
- Define a versioned **constraint registry** rather than a UPU-specific JSON blob. Start with: `allowed_use`, `prohibited_use`, `conditional_use`, `max_height`, `max_storeys`, `max_kig`, `max_kis_above_ground`, `max_gfa`, `min_lot_area`, `min_frontage`, `setback`, `building_line`, `buildable_area`, `required_access`, `parking`, `green_area`, `heritage/protection`, `infrastructure_reservation`, `phasing/precondition`, and `design_competition`. Every entry declares subject, denominator, units, comparison, geometry effect, evaluator version and `implemented | evidence_only | unsupported`.
- Each extracted atom needs `{value, unit, comparator, reference_datum, subject, denominator, condition, source_locator, extraction_method, confidence}`. A condition is a structured predicate where supported (for example “if public facility is delivered”), otherwise preserved as cited text and marks the outcome conditional/unknown.
- Treat alternatives as a set of mutually exclusive configurations, never a union of their maxima. A permitted representation can show several named configurations with their triggering conditions; it must not merge “or” clauses into one massing volume.
- Put translation through a reviewable ingestion pipeline: retain/download source artefacts and hashes; identify sheets/legends; georeference/vectorise; create cited features/atoms; validate geometry/topology and units; have a human approve the manifest; run a small fixed parcel cohort; then freeze the edition. Any failed source link, ambiguous legend, unregistered rule type or missing denominator remains visible as incomplete coverage.
- First pilot acceptance criteria: one fixed UPU boundary; every displayed constraint links to source page/sheet/feature; every selected parcel exposes intersection evidence and rule-resolution trace; no result uses a clipped fragment as a numeric denominator without an explicit source rule; changed source artefacts alter the edition hash; unsupported/conditional rules prevent a “compliant” verdict; a same-input re-evaluation is reproducible.
- MCP parity should be built around the same data and evaluator: `inspect_plan_edition`, `inspect_effective_rules(subject)`, `evaluate_permitted(subject, edition/evaluation)`, and granular draft operations to attach a citation, edit a typed atom, map a feature and set a precedence relation. These return the same evidence and unknown states as the UI. Adding a human map editor without these primitives would violate the repository’s documented parity requirement. [MCP parity inventory](../../permitted-plan-parcels.md#L74)
- Sequence: (1) source manifest and evidence browser; (2) boundary/feature extraction plus read-only rule trace; (3) single-UPU typed subset and selected-parcel evaluator; (4) frozen evaluation for all intersecting existing cadastre; (5) only then amendment/rebase and multi-UPU composition. This confines each new rule type to evidence, schema, evaluator and parity tests before citywide use.

### Gaps
- The rulebook identifies required categories, not a complete public machine-readable taxonomy or universal semantics for each legacy UPU. The registry must be empirical and edition-specific.
- No source reviewed here establishes that automated output alone is sufficient to issue or predict an individual permit. The system should describe an evaluation of recorded plan evidence, not a legal determination.
