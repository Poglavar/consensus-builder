# Click stack: one panel for everything under a map click

Design of record for 2D map selection (user decisions, 2026-10-22). It replaces the drill
panel (`#drill-stack-panel`), the parcel menu popover on left click, and the separate
right-side panels that clicks used to open one at a time.

## What a click does

- A click on the 2D map collects **everything under the point**, by geometry, not by which
  layer is drawn on top: agreements, designs, built buildings, permitted massing, the formed
  parcel, cadastral parcels, and the coordinates. Layers no longer swallow clicks.
- The result opens as **one right-docked panel** (the shared `--right-dock-width`; a bottom
  sheet on phones): a column of sections, with small gaps and connector lines between them to
  show that they are separate layers of one spot.
- Clicking the **same spot again** (the same topmost object) closes the panel, and so does a
  click on ground with nothing on it; a click on a different spot shows that spot. Escape and
  the close button close it too. This lets the map be explored without the panel.

## Sections, top to bottom (only those present at the point)

1. **Agreements** that contain any design at the point.
2. **Designs** at the point (applied proposals).
3. **Built**: existing buildings (a demolished one carries a "demolished by" badge).
4. **Permitted**: massing / envelope records.
5. **Formed parcel**: the parcel a design formed here. Never expands; it names the design.
6. **Cadastral parcels** under the point (or under the selected design).
7. Footer: the coordinates (copyable).

## Rows, strips and expansion

- Every section has a **one-line header row** that stays visible and clickable. Expanding a
  section collapses all the others; at most one is expanded.
- A section that can hold several instances (agreements, designs, cadastral parcels) shows a
  count in its header ("Designs (3)") and a **horizontally scrollable strip** of its instances,
  the same component for all three. The newest design (and agreement) is selected first.
- The expanded section is the **action view**:
  - Agreement: summary, "Show its designs" (highlights all of them on the map) and "Details"
    (opens the agreement panel).
  - Design: the proposal summary and actions, plus the agreements it belongs to as a strip.
  - Built: the building record. Permitted: the massing inspector.
  - Cadastral or formed parcel: the parcel info panel. Its tabs (Info, Propose, Proposals,
    Tools) and Info-tab controls (Select multiple, Detect block, History) are the parcel's
    actions; the section adds buttons only for what the panel lacks: Compare proposals here
    and Use as site. The other parcel commands stay in the command palette.
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
  lives in the parcel section and the selection tray.
