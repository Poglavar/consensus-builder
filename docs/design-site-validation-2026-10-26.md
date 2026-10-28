# Road edits and publication land boundaries

The reported Digbeth publication refused 89.9 m² outside a saved site after a road
was extended east and formed a junction. The server compared the current footprint
with the older saved land boundary. It did not forbid editing a published design:
editing creates a local revision, whose land must describe its new geometry.

Road edits now save the rebuilt footprint as the road's site and discard the old
parcel binding. This covers in-place geometry edits, published-road revisions,
split-off stretches, draft serialization, and both sides of a newly formed junction.
The new road's junction footprint is rebuilt before its site is saved too.
Publication derives the relationship to cadastral parcels again from the new site.
This does not change the meaning of a building's separate, potentially larger site.

The containment rule remains: published geometry must be represented by its saved
land boundary. Its refusal now returns `outsideM2`, `outsideGeometry` and `site`.
The geometry is the actual PostGIS difference after the existing intrusion noise
filter, not a separately approximated browser difference. The message says
“design”, identifies the local design by name, and frames red outlying pieces with
a dashed yellow saved boundary. Desktop framing accounts for the Designs panel;
an expanded mobile sheet lowers to reveal the map. Closing the sharing panel or
starting another publication removes the review overlay.

## Verification

- Initial targeted headless unit run: 7 files, 222 tests; 216 passed, 6 failed.
  Five failures were outdated wording/validation-order expectations; one expected
  the old publication message without its newly added design name. Expectations
  were updated to the current contracts.
- Targeted headless unit rerun: 8 files, 228 tests passed.
- Final targeted headless unit run: the same 8 files, 231 tests passed. A concurrent
  junction task added three cases between the runs. No full suite ran; no run was
  stopped.
- Files: `proposal-binding`, `design-sync`, `proposal-editor-adapters`,
  `road-drawing.characterization`, `corridor-authoring`,
  `corridor-authoring-lifecycle`, `designs-route`, and `road-edit-save` under
  `backend/test`, each with the `.test.js` suffix.
- Local PostGIS read-only checks: contained sample road returned 0 m² and no
  outlying geometry; its eastward extension returned 75.6033894866705 m² and a
  MultiPolygon describing the extension.
- A dedicated headed Chrome verified the real Publish button and Designs panel
  at desktop and 390 × 844 mobile sizes, using that SQL result as a simulated
  refusal. Pinning and indexing requests were intercepted inside that browser;
  no test publication was uploaded. Both outlines were visible; panel close
  removed both. The dedicated browser was closed afterward.

The exact unpublished working design selected by the report's local ID is not in
the published plan URL, so its exact 89.9 m² edit was not independently measured.
No production deployment or publication repair was performed.
