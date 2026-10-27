# Agreement properties and parcel context

Agreement properties remain inside the expanded stack section. Overview contains the plan,
designs, publication, applicable voting and chain controls. Input parcels, Output parcels, Persons
and Rules have separate tabs; community agreements omit allocation/person tabs. Status and primary
actions stay above the tabs. The selected tab survives refresh; keyboard arrows, Home and End
navigate tabs. All tabs fit the panel with equal widths and wrapped labels.

Design, input, output and person rows support hover/focus geometry previews. Clicking frames and
highlights the object while keeping the agreement open. Inputs use original cadastral geometry;
outputs use the agreement's exact geometry; designs use their displayed revision. Persons inspect
their contributed parcels and explicitly allocated outputs. Published read-only records permit
spatial inspection without authoring actions. Hash-only outputs have no fabricated geometry.
Input fetches use the existing busy controls. Model/photoreal framing and emphasis reuse the scene's
existing feature-based focus functions; the 2D map uses the existing inspection/hover overlays and
panel-aware fit padding.

Parallel buttons share their row equally across both stack frames. Large relationship groups wrap
into pairs, with triples sharing one row. The cadastral History label aligns beside its clock icon.

The design Overview metric is now Source parcels in every locale. A design has one authored site
but may form several body pieces or layout plots. The previous plan-member lookup incorrectly
treated every piece bearing the producer ID as body land. Cuts stamp producer metadata on leftover
remainders too. The shared formation helper now identifies actual structure, building, corridor
or layout-plot roles; the design's Formed parcels list excludes remainder land. Materialization,
authored geometry and ownership are unchanged. The vocabulary records this distinction.

MCP parity: no editing field, authoring operation or schema changed. Existing agreement inspection,
parcel context and granular agreement editing expose the same records and geometry. The shared
record/ground validators and allocation rules are unchanged. Targeted MCP ground tests passed;
the inspection helper also verifies that geometry lookup leaves the agreement untouched.

Targeted verification (no full suites and no stopped runs):

| Type and scope | Result |
| --- | --- |
| Headless unit: agreement panel, formation depth, stack hits | 79 passed; 1 obsolete design-button markup assertion failed |
| Headless unit: those files plus History and locale coverage | 111 passed; 1 dynamic translation-prefix check failed |
| Headless unit: locale coverage after using explicit existing keys | 22 passed |
| Final headless unit: agreement panel, formation depth, stack hits and MCP ground | 90 passed |
| Headed Playwright: desktop/phone properties and read-only route | Read-only route passed; 2 new fixtures lacked the required agreement schema |
| Headed Playwright: corrected desktop/phone properties | 2 passed |
| Headed Playwright: source labels, equal button pairs and inline History | 2 passed |
| Final headed Playwright: equally fitted tabs, map hover/click, input/output/person geometry and equal button triples | 2 passed |

Screenshots were visually reviewed on desktop and phone. Browser tests use the real app with mocked
source responses and verify no agreement mutation from inspection. The 3D adapter reuses existing
scene code but was not exercised with a running 3D renderer in this pass.

Concurrent open-ground changes also touch map.css and the locale dictionaries. Those mixed files
remain uncommitted; their equal-row styling and Source parcels label changes are present locally.
Other files in this change are committed separately from the unrelated open-ground work.
