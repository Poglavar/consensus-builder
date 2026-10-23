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
  point's own hits, and only the point's own hits open by default and decide the same-spot close,
  so a click on open ground still opens the parcel.
- The result opens as **individual cards directly over the map**, in the shared right-dock
  column (`--right-dock-width`; full width on phones). Small gaps and short connector lines
  show that these sections describe layers of one spot. The positioning container has no
  background, heading, or close button; each section owns the shared translucent surface.
- Clicking the **same spot again** (the same topmost object) closes the panel, and so does a
  click on ground with nothing on it; a click on a different spot shows that spot. Escape
  closes the selection too. This lets the map be explored without the panel.

## Sections, top to bottom (only those present at the point)

1. **Agreements** that contain any design at the point.
2. **Designs** at the point (applied proposals), or the proposals on the parcel there.
3. **Built**: existing buildings at the point, or on the parcel there (a demolished one carries a
   "demolished by" badge).
4. **Permitted**: massing / envelope records.
5. **Formed parcel**: the parcel a design formed here. Never expands; it names the design.
6. **Cadastral parcels** under the point (or under the selected design).
7. Footer: the coordinates (copyable).

## Rows, strips and expansion

- Every section has a **one-line header row** that stays visible and clickable. Expanding a
  section collapses all the others; at most one is expanded.
- A section that can hold several instances (agreements, designs, buildings, cadastral parcels) shows a
  count in its header ("Designs (3)") and a **horizontally scrollable strip** of its instances,
  the same component for each. The newest design (and agreement) is selected first.
- The expanded section is the **action view**:
  - Agreement: summary, "Show its designs" (highlights all of them on the map) and "Details"
    (opens the agreement panel).
  - Design: the proposal's actions panel itself (2026-10-23), without its own − and ×: an
    Overview tab (name, rung badges, type, author, parcel count and one area) and a Details tab
    (land and ownership, verification, the record), with the actions under both; plus the
    agreements it belongs to as a strip. Starting Before / after from it folds the stack to its
    rows (the card stays hosted, so the comparison keeps running); a row click unfolds it.
- A proposal just placed (an editor's Done, a one-click structure, the create dialog) opens the
  stack at a point inside it with its Design section expanded, instead of a card of its own. No
  click opened that spot, so the first click on the design is a new click, not a close.
  - Built: the building record. Permitted: the massing inspector.
  - Cadastral or formed parcel: the parcel info panel. The cadastral section heading is
    **Cadastral parcel <reference>**; it replaces the panel's duplicate identity heading and
    the former area/ownership summary. Source and formed-ground provenance remains in Info.
    **Select multiple parcels** (Manually / Detect block) sits above the tabs, before
    **Custom site**. Custom site starts an editable working boundary; it does not change the
    parcel layout and remains available for drawing a design over that boundary.
    **Design · Info · Tools** are the tabs. Design opens first; a selected tab stays selected
    on subsequent parcel clicks. The panel's Proposals tab is hidden inside the stack because
    Designs already lists those records. Outside the stack the panel retains Proposals and
    its standalone heading/close controls. Hosted Built/Permitted inspectors have no close
    button: their section heading collapses them or another section takes over.
- The map highlight follows the expanded section and its selected instance.
- **Memory:** the kind of the expanded section is remembered (also across reloads). The next
  click expands that kind if it exists there, otherwise the topmost section.

## Code

- `frontend/js/click-stack/click-stack-model.js`: pure ordering, counts, default instance,
  remembered kind, close-or-switch decision (unit tested, no DOM).
- `frontend/js/click-stack/click-stack-hits.js`: collects the hits at a point from the live
  layers (drill stack for designs and parcels, building layers, planning items, agreements).
- `frontend/js/click-stack/click-stack-panel.js`: the panel; hosts the existing panels
  (planning inspector, proposal card, parcel info panel) inside the expanded section.
- The parcel menu popover is removed. Shift multi-selection and its tray stay; "use as site"
  lives in the parcel section as Custom site and in the selection tray.

## 3D model view

The 3D model view has its own click stack (`frontend/js/three-click-stack.js`, user decisions
2026-10-23): the same right-docked column and row/strip look, with what a click in the scene stands
on. It replaced the floating top-left parcel / "Proposal info" panel.

- Sections, top to bottom: **Built** (the clicked building, and the existing buildings standing on
  the parcel, as a strip), **Design** (the clicked proposal, or the proposals on the parcel),
  **Permitted** (the clicked massing, or the parcel's cached massing), **Parcel** (the one parcel).
- The clicked thing's section opens; one section is open at a time.
- Design open: the proposal is isolated (as before) and the section shows the whole proposal's info
  and Built / Planned / Proposed figures with the price sliders, then its authored record from the
  Buildings and massing inspector. Parcel open: the same figures for the one parcel.
- Built and Permitted host the Buildings and massing inspector.
- A proposal click's parcel is the proposal's own parcel slice under the point, not the slab the ray
  reaches beside a tall design (`three-click-plan.js`).
- The click rules stay those of `three-click-plan.js`: a second click on the viewed parcel isolates it,
  a third clears; a second click on the isolated proposal clears. Clearing, Escape, the isolation
  banner's ×, a massing chosen in the Buildings and massing sheet, and leaving 3D close the stack.
- The pure rules (order, focus, strips, labels) are in the module's first half and unit tested
  (`backend/test/three-click-stack.test.js`); the 2D model (`click-stack-model.js`) is not shared,
  because its order puts Design above Built.
