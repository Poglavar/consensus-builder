# Right screen panels

Right-side map surfaces share the click stack's 400 CSS pixel desktop width and 10px right gap.
`--right-dock-width` and `--right-dock-gap` remain the sizing source in panels.css. The semantic
`right-screen-panel` class supplies common typography, glass, border, radius, shadow, header and
body spacing in right-screen-panel.css. Its surface rule also includes click-stack cards, retaining
the stack's transparent gaps and selected object's yellow focus ring. `right-dock-panel` remains
the inspector-specific phone-dock hook. Hosted content fits its parent stack card.

The class covers both click stacks; parcel, design, road and source inspectors; block details and
the urban-block browser; road analysis/results; agreement creation and properties; custom-site
panels; map geometry editors and the design draft editor; watched-area details; the Schelling layer
panel; and the plan critic's result card. Component-specific width declarations were removed.
Geometry editors no longer have a separate wide variant.

Lists, Layers and Settings use the same desktop right edge and top clearance as the stack. Lists
keeps a scrolling viewport. Shared bottom clearance follows actual overlap with stationary
navigation and feedback. Phone surfaces retain the shared resize handle and viewport constraints.
Map sheets retain their existing Escape and outside-click rules.

Bets and Activity keep their wider centred navigation frame. Wide comparison, tabular and other
dialog content belongs in a centred or full-screen surface rather than a wider right column.
Left-anchored utilities and centred dialogs are separate presentation types.

MCP parity: this is a presentation/layout change. No authored fields, editing operation, validation,
record format or source of truth changes. Existing granular MCP operations continue to edit the
same designs, plans, agreements, settings and ownership records; no MCP tool/schema change is needed.
The domain vocabulary is unchanged.

Targeted verification:

| Type and scope | Result |
| --- | --- |
| Headless unit, editor lifecycle, dock sheets, shell capabilities and clearance | 32 passed; one existing navigation-order assertion was stale |
| Final headless unit, the same four files with the current navigation order | 33 passed |
| Headed Playwright, four new layout cases | Phone passed; two assertions included the selected card's extra focus ring, and one locator included the hidden Schelling panel |
| Headed Playwright, corrected four cases plus two existing clearance cases | Six passed |
| Final headed Playwright, five layout/editor cases after title alignment | Five passed |
| Manual headed Chrome against the local API | Layers measured 400px wide with a 10px right gap; seven cadastral features and five building footprints returned |

No full suite ran and no run was stopped. Desktop, narrow-desktop and phone screenshots were
visually reviewed. The browser layout cases use real app markup with mocked source responses;
the clearance cases exercise the actual controller and styles without starting a map renderer.
Concurrent work also edits index.html, the 2D panel and proposal-editor shell. Those mixed files
remain local rather than committing another session's changes.
