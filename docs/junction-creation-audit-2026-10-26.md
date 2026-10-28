# Junction creation and painting audit — 2026-10-26

## Report and reproduction

The reported 2D crossroads had differently shaded tapers. The screenshot's western approach ends about five metres from the crossing, while the eastern approach continues much farther. Different approach lengths can legitimately produce different corner radii and cuts. Different asphalt shades from overlapping paint are a defect.

The real reproduction used the Digbeth plan `bafkreiglpr2252u5lkwi6uniama2prn46qlxptjjqpjtara5zdias2ybxy`, near 52.480216, −1.880013, in a disposable headed Chrome. Editing published North Street reproduced two simultaneously applied alternatives: its published predecessor and its new local revision. Both rendered asphalt and arrows. The earlier capture was saved outside the repository as a diagnostic artifact.

## Findings and changes

1. **Published road revisions did not retire overlapping applied alternatives.** The creation transaction excluded the source from topology discovery but left it applied. It now uses the existing ground-conflict rule to stand down overlapping alternatives in the same transaction. Unrelated and disjoint roads remain applied. Failed derivation restores the source and removes the provisional revision. In-place edits also stand down overlapping historical revisions.
2. **Cross-section and geometry edits could leave neighbouring arm snapshots stale.** `planCorridorEdit` nodes the edited road against its applied neighbours, then rebuilds snapshots at affected old and new nodes from current profiles. Source and affected peers join one rematerialization scope. Unrelated roads are unchanged. Shared-node drag/undo batches defer intermediate discovery so a half-completed move cannot author transient crossings.
3. **Drawing previews painted strips beneath their own junctions.** Draft strips now use the same junction paint clipping as applied roads. Preview junctions also temporarily own the affected applied peers' strips and markings. The normal applied junction at the same position and level is suppressed while the draft owns that surface. Clearing the preview restores ordinary rendering; unaffected corridors retain their cached render.
4. **Rendering lost level identity.** Junction collection, footprint joins, signatures and render keys now preserve discrete levels. Same-position nodes on different levels stay separate. Projecting a render-only T node requires both edge endpoints and the joining point to share a level. Drawing previews follow the same rule and borrow the applied renderer's junction-eligible surface runs, excluding protected spans.
5. **Equal-width duplicate arms depended on input order.** Maximum width still wins; ties now use a deterministic orientation-aware profile key supplied by the profile adapter. Reordered inputs and equivalent reversed centerlines produce the same treatment.

## Reviewed boundaries

- Creation and published-source derivation: `proposal-manager.js`, `proposals/corridor-authoring.js`.
- Local edits, finish, preview cleanup and peer rematerialization: `road-drawing.js`.
- Shared-node movement/undo and protected topology: `corridor-network-nodes.js`, existing node-edit paths.
- Junction graph, corner geometry, profile orientation, marking trims and surface clipping: `corridor-junction.js`, `corridor-profile.js`, `corridor-junction-paint.js`.
- Occupied land and rendering: `corridor-footprint.js`, `corridor-render.js`.
- 3D treatment consumption: `three-mode.js` uses the shared treatment geometry and terrain/strip elevation path. Discrete level labels are not interpreted as metre heights. No 3D source was changed and no 3D visual result is claimed by this audit.
- MCP agreement authoring already authors a complete included road network before binding and calculation. Published-record loading remains a reader; this change does not rewrite old published topology on import.

Existing experimental records with duplicated applied alternatives are corrected by the normal edit/reapply transaction, not a new boot migration. This audit does not assert that every geometrically unequal crossroads should look symmetric.

## Verification

Final targeted **headless unit tests**: 13 explicitly named files, **178 passed**. The files were `corridor-junction`, `corridor-footprint`, `corridor-lane-topology`, `corridor-render-incremental`, `corridor-junction-paint`, `road-drawing-junction-preview`, `corridor-authoring`, `corridor-authoring-lifecycle`, `road-drawing.characterization`, `road-node-edit`, `corridor-network-nodes`, `corridor-editor-lifecycle`, and `corridor-levels` under `backend/test/`. Vitest ran with at most two workers.

Final targeted **headed Playwright tests**: 3 cases across 3 specs, **3 passed**, one background Chrome worker:

- `junction-paint.spec.ts`: a short western approach, immutable-source cross-section edit, one applied alternative per road and one junction surface. It inspects actual Leaflet paths and asserts less than 0.02 m² overlap between driving strips and junction asphalt, with matching colour and opacity. Its captured screenshot was visually inspected.
- `corridor-creation.spec.ts`: applied-road cross-section edit and persistence after reload.
- `road-editor-complete-controls.spec.ts`: snapped road branch, shared-node movement and undo.

The real Digbeth plan was also opened against the production API in a disposable headed browser. Repeating the edit after the fix retained three applied roads, stood down the published North Street predecessor, and rendered one junction surface with one asphalt colour and no doubled arrows. Direct plan and design API reads both returned 200. No public designs were published or modified. Local rendering uses the listening checkout with no-store asset responses.

The shared worktree already contains the authoring, level and alternative-replacement changes in commits `2c2f8e418` and `29b24e730`. The remaining `road-drawing.js` changes mix this audit's preview work with another session's deferred shared-node guard, so that file is intentionally left uncommitted under the repository's collaboration rule. The associated `corridor-network-nodes.js` edit belongs to that other session.

Iteration log (all runs targeted; no full suites):

| Test type | Scope | Result |
| --- | --- | --- |
| Headless unit | Preview/paint, initial invocation | Wrong working directory prevented resolving `proj4`; corrected before rerun. |
| Headless unit | Preview/paint, 2 files | 18 passed. |
| Headless unit | Junction/topology, initial invocation | Wrong `node --test` runner for Vitest files; corrected. |
| Headless unit | Junction/topology, 2 files | 19 passed. |
| Headless unit | Junction/topology/footprint/paint/render, 5 files | 66 passed. |
| Headless unit | Authoring planner, 1 file | 18 passed. |
| Headless unit | Drawing/authoring/lifecycle, 3 files | 57 passed. |
| Headless unit | Peer refresh regression, 2 files | Exposed unrelated canonicalized records being returned; changed-ID filtering corrected. Isolated drawing fixture also needed `proj4`. |
| Headless unit | Corrected drawing/authoring, 2 files | 54 passed. |
| Headless unit | Alternative replacement and rollback, 1 file | 20 passed. |
| Headless unit | Draft/applied preview masks, 3 files | 36 passed. |
| Headed Playwright | First browser check, 3 cases | 3 passed. |
| Headless unit | Initial aggregate check, 13 files | Completion output was not retained across context compaction; superseded by the final logged run. No duplicate active run was started. |
| Headless unit | Final aggregate with stacked-preview regression, 13 files | 178 passed. |
| Headed Playwright | Final browser check after preview-level change, 3 cases | 3 passed. |

No run was deliberately stopped. Host contention was high during part of the audit; these runs are correctness evidence, not performance measurements. No deployment or push was requested for this audit.
