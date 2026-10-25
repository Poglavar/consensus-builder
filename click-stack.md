# Click stack: sections for everything under a map click

Design of record for 2D map selection (user decisions, 2026-10-22). It replaces the drill
panel (`#drill-stack-panel`), the parcel menu popover on left click, and the separate
right-side panels that clicks used to open one at a time.

## What a click does

- A click on the 2D map collects **everything under the point**, by geometry, not by which
  layer is drawn on top: agreements, designs, built buildings, permitted massing, the formed
  parcel, cadastral parcels, and the coordinates. Layers no longer swallow clicks.
- When **no design is under the point**, the parcel there also adds what stands on it
  (2026-10-23): its buildings to Built and its proposals to Designs, this browser's and the
  published ones it has no copy of (a published one is imported when opened). They follow the
  point's own hits, and only the point's own hits open by default,
  so a click on open ground still opens the parcel.
- The result opens as **individual cards directly over the map**, in the shared right-dock
  column (`--right-dock-width`; full width on phones). Small gaps and short connector lines
  show that these sections describe layers of one spot. The positioning container has no
  background, heading, or close button; each section owns the shared translucent surface.
- One section is always **selected** while the stack is open. Expansion only controls its
  details. Collapsing keeps its header selected and its object highlighted on the map.
- Clicking the selected object again retains it. Escape deselects and closes the stack; a different
  object replaces the selection. Clicking empty ground, or another surface taking the map, can
  also dismiss it.

## Sections, top to bottom (only those present at the point)

1. **Agreements** that contain any design at the point.
2. **Designs** at the point (applied proposals), or the proposals on the parcel there.
3. **Built**: existing buildings at the point, or on the parcel there (a demolished one carries a
   "demolished by" badge).
4. **Permitted**: massing / envelope records.
5. **Formed parcel**: the live ground a design formed here, with its parcel actions.
6. **Cadastral parcels** under the point (or under the selected design).
7. Footer: the coordinates (copyable).

## Rows, strips and expansion

- Every section has a **one-line header row** that stays visible and clickable. Expanding a
  section collapses all the others; at most one is expanded.
- Collapsed headers are one row: the object kind followed by its selected name or parcel ID,
  truncated with an ellipsis. The cadastral header has no copy button.
- Contextual strips sit close to, but outside, the selected card. A fixed **(count)** at the left
  precedes horizontally scrolling choices; there is no separate strip heading. They navigate
  related objects, never siblings of the object already selected:
  - An agreement offers its designs below it, in authored order.
  - A design offers its agreements above and its formed land below it.
  - A formed parcel offers its producing design above and source cadastral parcels below it.
  - A source parcel can offer its formed pieces above it.
  Selecting a related item selects and expands its section and replaces the old context strips.
- The expanded section is the **action view**:
  - Agreement: summary, "Show its designs" (highlights all of them on the map) and "Details"
    (opens the agreement panel).
  - Design: the proposal's actions panel itself (2026-10-23), without its own − and ×: an
    Overview tab (name, rung badges, type, author, parcel count and one area) and a Details tab
    (land and ownership, verification, the record), with the actions under both; plus the
    agreements it belongs to as a contextual strip above the card. Starting Before / after from it folds the stack to its
    rows (the card stays hosted, so the comparison keeps running); a row click unfolds it.
- A proposal opened from a list, shared link, restored selection, or just placed (an editor's Done,
  a one-click structure, the create dialog) opens the
  stack at a point inside it with its Design section expanded, instead of a card of its own. No
  click opened that spot, so the first click on the design is a new click, not a close.
  - Built: the building record. Permitted: the massing inspector.
  - Cadastral or formed parcel: the parcel info panel. The cadastral section heading is
    **Cadastral parcel · <reference>**; it replaces the panel's duplicate identity heading and
    the former area/ownership summary. Source and formed-ground provenance remains in Info.
    **Select multiple parcels** (Manually / Detect block) sits above the tabs, before
    **Custom site**. Custom site starts an editable working boundary; it does not change the
    parcel layout and remains available for drawing a design over that boundary.
    **Design · Info · Tools** are the tabs. Design opens first; a selected tab stays selected
    on subsequent parcel clicks. A source parcel replaced by applied designs opens on Info,
    explaining that its original cadastral boundary is retained and highlighted. Its Design tab
    offers selection of the current parcels for further design work. Source selection always
    outlines the immutable repository geometry, including while collapsed.
    The panel's Proposals tab is hidden inside the stack because
    Designs already lists those records. The selected-set section retains Proposals for the whole
    set. Parcel information and proposal actions open only inside the click panel; there is no
    automatic companion parcel panel beside a selected proposal. Hosted Built/Permitted inspectors have no close
    button: their section heading collapses them or another section takes over.
- The selected object has a pulsing map outline, retained while collapsed and protected from hover. Reduced motion uses a steady border. The selected collapsed header is highlighted too. Black, 4px connectors run centrally behind the cards.
- **Memory:** the kind of the expanded section is remembered (also across reloads). The next
  click expands that kind if it exists there, otherwise the topmost section.

## Code

- `frontend/js/click-stack/click-stack-model.js`: pure ordering, counts, default instance,
  remembered kind, close-or-switch decision (unit tested, no DOM).
- `frontend/js/click-stack/click-stack-hits.js`: collects the hits at a point from the live
  layers (drill stack for designs and parcels, building layers, planning items, agreements).
- `frontend/js/click-stack/click-stack-panel.js`: the panel; hosts the existing panels
  (planning inspector, proposal card, parcel info panel) inside the expanded section.
- In Manual or Shift multi-selection, **Selected parcels (N)** replaces the point-specific
  sections. It shows measured total area and hosts the parcel Design / Info / Proposals / Tools tabs for the
  whole selection. Clear keeps selection mode active, including an empty selection; Done exits
  and clears it. The header can fold while map clicks keep changing the selection. There is no
  bottom selection tray. Detect block and Custom site remain in the section, before the tabs.

## 3D model view

The 3D model view has its own click stack (`frontend/js/three-click-stack.js`, user decisions
2026-10-23): the 2D stack's frame and row/strip look (`#click-stack, #three-click-stack` share the
rules in `css/map.css`), with what a click in the scene stands on. Like 2D it has no panel, header or
close button: the section cards float over the scene, and the stack closes on Escape, a click on
nothing, or another selection. It replaced the floating top-left parcel /
"Proposal info" panel.

- Sections, top to bottom: **Built** (the clicked building, and the existing buildings standing on
  the parcel, as a strip), **Design** (the clicked proposal, or the proposals on the parcel),
  **Permitted** (the clicked massing, or the parcel's cached massing), **Parcel** (the one parcel).
- The clicked thing's section opens; one section is open at a time.
- Repeated scene clicks on the same object or map spot advance through the available sections in
  their displayed order, wrapping from Parcel to the first section. This works independently of
  double-click speed. A different object starts with its own section; clicking elsewhere or Escape
  dismisses the stack. A folded selection reopens before advancing. Header clicks still select a
  section directly. All selections preserve the camera and keep the scene in context;
  refreshes retain that viewing policy. A stack opened from a list or link starts a fresh scene-click sequence.
- Expanded cards fit their content. Long content scrolls within the available dock height after
  reserving room for every other section header; a short Built record leaves Parcel visible below.
- Design open: the composition stays visible and the section shows the whole design's info
  and Built / Planned / Proposed figures with the price sliders. **Proposal actions** switches to
  the same design in the 2D click panel. Restoring a design or entering through a shared model link
  opens this section; authored selections never open the Buildings and massing inspector.
  Parcel open: the same figures for the one parcel.
- Built and Permitted host the Buildings and massing inspector.
- A proposal click's parcel is the proposal's own parcel slice under the point, not the slab the ray
  reaches beside a tall design (`three-click-plan.js`).
- Selection and expansion are independent here too. Collapsing retains the selected header and
  scene outline; switching sections replaces the previous object's emphasis. A thick yellow pulsing
  outline follows actual drawn volumes for Built, Permitted and building designs, and the ground
  boundary for parcels and ground-only designs. Ground designs additionally carry a transparent
  yellow hatch; formed and cadastral parcel selections remain unfilled, even where their geometry
  is identical to the design. No parcel material changes; reduced motion keeps the outline steady. The shared contextual
  relationship rules connect designs, agreements and parcels; the model view keeps its own section order.
- The pure rules (order, focus, strips, labels) are in the module's first half and unit tested
  (`backend/test/three-click-stack.test.js`); the 2D model (`click-stack-model.js`) is not shared,
  for section ordering, because 2D puts Design above Built; contextual relationships are shared.

In aerial imagery mode, source-parcel inspection uses the same 3D click-panel frame. Its Parcel
section hosts the immutable source reference and measured area; Escape closes the selection.
Design editors remain separate from parcel information and design actions. The experimental parcel-study UI is removed.
