# Click stack: sections for everything under a map click

Design of record for 2D map selection (user decisions, 2026-10-22). It replaces the drill
panel (`#drill-stack-panel`), the parcel menu popover on left click, and the separate
right-side panels that clicks used to open one at a time.

## What a click does

- A click on the 2D map collects **everything under the point**, by geometry, not by which
  layer is drawn on top: designs, built buildings, permitted massing, formed ground, cadastral
  parcels and coordinates. Exact-revision Plans and their scoped Agreements are related context;
  agreements have no independent pick geometry. Layers no longer swallow clicks.
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

1. **Agreements** that contain a design at the point.
2. **Plans** whose saved design set contains a design at the point.
3. **Designs** at the point (applied proposals), or the proposals on the parcel there.
4. **Built**: existing buildings at the point, or on the parcel there (a demolished one carries a
   "demolished by" badge).
5. **Permitted**: massing / envelope records.
6. **Formed parcel**: the live ground a design formed here, with its parcel actions.
7. **Cadastral parcels** under the point (or under the selected design).
8. Footer: the coordinates (copyable).

## Rows, relationships and expansion

- Every section has a **header row** that stays visible and clickable. Expanding a
  section collapses all the others; at most one is expanded.
- Collapsed headers are one row: the object kind followed by its selected name or parcel ID,
  truncated with an ellipsis. The cadastral header has no copy button.
- A collapsed Design header shows only “Design” and the selected name on one line, with no
  collection count or type badge. The expanded header shows the authored type as a prominent
  colored icon pill, repeated in its details; its name may wrap below the type row. Color
  supplements the type text and icon; it does not indicate publication or approval.
- Relationship groups are small, explicitly labelled link groups **inside the expanded card body**.
  Their links wrap to fit the card; they do not create horizontal scrolling. A group navigates
  related objects, never siblings of the object already selected:
  - A plan offers its included designs. An agreement references exactly one Plan revision;
    it has no independently authored design membership.
  - A design offers the plans and agreements it belongs to, plus its affected parcels or formed land.
  - A formed parcel offers its producing design and source cadastral parcels.
  - A source parcel can offer its formed pieces or designs on that parcel.
  A group is omitted when its sole target is the same sole visible instance already shown in the
  target section. Missing or off-screen targets remain useful links. Selecting a related item
  selects and expands its section.
- **Agreements sit above Plans, followed by Designs.** Plans are discovered for the exact design
  revision; agreements are loaded only for the selected exact Plan CID. Switching Plans replaces
  the agreement choices, and stale responses from the previous plan are discarded. Agreement
  sections show decision/allocation terms with an explicit Agreement details action. Inspecting
  either a plan or its agreement highlights the plan’s extent without importing or applying its
  designs. The Plan button in agreement details selects that Plan in the current stack, preserving
  the camera, workspace and address. Multiple agreements share the same native instance selector.
- When a section has multiple instances, its expanded card contains a compact native selector for
  switching among those peers. A singleton has no selector.
- The Design selector says **Location you clicked has multiple designs. Select which to inspect:**
  above the control. Its closed face shows only the selected design's title. The native menu
  includes each design's authored type and available exact-revision plan membership alongside
  its title. The selector replaces the repeated title in the expanded card; a singleton keeps
  its ordinary title. Membership updates refresh menu labels without replacing the control.
  Its count is the number of separate designs overlapping the location or using its parcel;
  selecting one changes the inspected design.
- The expanded section is the **action view**:
  - Plan: meaning, name, included designs, combined map highlight, Share plan and Create agreement.
    Agreement: decision/allocation terms and the inherited plan extent; Agreement details opens
    the full agreement record.
  - Design: the proposal's actions panel itself (2026-10-23), without its own − and ×: an
    Overview tab (name, rung badges, type, author, parcel count and one area) and a Details tab
    (land and ownership, verification, the record), with the actions under both; plus the
    member plans and agreements inside the card body. Starting Before / after from it folds the stack to its
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
- The selected object has a pulsing map outline, retained while collapsed and protected from hover.
  Reduced motion uses a steady border. The selected card and its distinct circular icon node carry
  the selected highlight. Short connectors run behind the cards on the icon axis near the left edge.
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
  selection mode and retains the selected parcels. The header can fold while map clicks keep changing the selection. There is no
  bottom selection tray. Detect block and Custom site remain in the section, before the tabs.

## 3D model view

The 3D model view has its own click stack (`frontend/js/three-click-stack.js`, user decisions
2026-10-23): the 2D stack's frame and card/row/relationship look (`#click-stack, #three-click-stack` share the
rules in `css/map.css`), with what a click in the scene stands on. Like 2D it has no panel, header or
close button: the section cards float over the scene, and the stack closes on Escape, a click on
nothing, or another selection. It replaced the floating top-left parcel /
"Proposal info" panel.

- Sections, top to bottom: **Built** (the clicked building, and the existing buildings standing on
  the parcel), **Agreements**, **Plans**, **Design** (the clicked proposal, or the proposals on the
  parcel), **Permitted** (the clicked massing, or the parcel's cached massing), **Parcel** (the one
  parcel).
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
- Plans and agreements use the same lazy exact-revision membership lookup and read-only geometry
  inspection as 2D; explicit links open their full records. Inspecting parent records never imports
  or applies member designs.
- The pure rules (order, focus, relationships, labels) are in the module's first half and unit tested
  (`backend/test/three-click-stack.test.js`); the 2D model (`click-stack-model.js`) is not shared,
  for section ordering, because 2D puts Design above Built; contextual relationships are shared.

## Google 3D view

Google and model 3D use the same click handler, stack, section bodies, relationship links,
selection colour, collapse behaviour, repeated-click cycling and Escape dismissal. Selecting
an object retains the camera and surrounding composition in both views. Building/source
inspectors and permitted representation choices are available in Google view too.

The photo renderer supplies the visible surface hit and source cadastral geometry. Authored
geometry in front of that surface selects its design; a raw Google triangle removed by an
applied design's visual carve does not block that design. A Google surface point resolves
building identity from known source footprints rather than hidden model meshes. The stack
also offers formed and source parcels, the parcel's designs and permitted source records.
Overlapping parcels use the ordinary section selector. A source object without a known
footprint cannot be identified from Google's unlabelled visual mesh alone.

Yellow selection boundaries follow the loaded photo surface. Authored drawn volumes retain
volume outlines; Google buildings without an addressable authored mesh use their source
footprint boundary. Missing surface heights leave gaps rather than introducing zero heights.
The cadastral boundary layer remains a drawing preference: hiding it neither closes the
selection nor disables parcel clicks. The former independent photo parcel picker and its
read-only reference/area card are retired.
