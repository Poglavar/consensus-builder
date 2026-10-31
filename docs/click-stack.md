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
  column (400 CSS pixels via `--right-dock-width`, with a 10px right gap; full width on phones).
  The shared `right-screen-panel` class also styles other right-side inspectors, settings, lists
  and map editors. Wider content uses a centred dialog rather than widening that column.
  Small gaps and short connector lines
  show that these sections describe layers of one spot. The positioning container has no
  background, heading, or close button; each section owns the shared translucent surface.
- One section is always **selected** while the stack is open. Expansion only controls its
  details. Collapsing keeps its header selected and its object highlighted on the map.
- A click always selects the **topmost object** under it: designs above parcels. Plans and
  agreements are never spatial picks; they arrive through lists, links and panels.
- A repeat click on the same object keeps the stack and re-opens that object's section, also when
  another section had been expanded or everything was collapsed. A different object replaces the
  selection. Escape or a click on nothing closes the stack; another surface taking the map can
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

## Mobile navigation

On phones, 2D and both 3D views show one horizontal **object tab bar** with the standard
object icons. Ground and selected sets come first, followed by cadastral parcels, formed
parcels, built/permitted records, designs, plans and agreements. Small chevrons between
adjacent authored levels indicate their order; buildings and permitted records are not
presented as members of that chain. Selecting an icon opens its section. Desktop keeps
the neighbouring section headers described below.

The selected header remains below the object tabs. Collapsing it leaves those two rows
and the map; there is no drag handle. Expanded content fits its contents up to 55% of the
visible viewport, then scrolls. **Full screen** gives it the viewport; **Show map** restores
the content-sized panel. List previews and **Focus** return to map-visible mode. Closing
uses the header's close button, Escape, or the existing map selection behavior.

Both desktop and mobile use one **content tab bar** at the top of the expanded body,
above any instance selector. Existing panel tabs are promoted into this bar, retaining
their editors, controls, loading behavior and state:

- Designs: Info, Details (or Input parcels / Output parcels for a parcel layout), Actions,
  and tabs for related Plans and parcels where present. The model view keeps its figures
  and sliders in Info; Actions opens the same design's Actions tab in 2D.
- Plans: Designs, Agreements, Actions and Info. Agreements always has a tab, including
  an empty state when no agreement references the exact Plan revision.
- Cadastral/formed parcels: Actions, Info, Tools and applicable relationship lists such
  as Designs. A selected set keeps its native whole-set design list.
- Agreements: Overview, Input parcels, Rules, Actions and, for owners' agreements,
  Output parcels and Persons. Voting and chain controls remain with their overview.

Changing content tabs remembers the active page per object and the scroll position
within that mounted section. Full-screen/map-visible switching preserves its contents.
Relationship lists remain one item per row with single-line, ellipsized labels.

## Neighbours

The stack is built from the selected object outward, in both directions. Each kind has one
lookup that reads the selected object's own references; it runs when the stack opens and on every
selection change (a row, a related link, a selector). How the stack was reached (a map click, a
list, a link, a plan or an agreement) only decides what is selected and expanded, so the same
object always shows the same sections around it. What each kind contributes:

- **Agreement**: its plan.
- **Plan**: its member designs and the agreements of that revision.
- **Design**: its plans, its formed pieces and its cadastral parcels.
- **Formed parcel**: its producing design and its source parcels.
- **Cadastral parcel**: the pieces cut from it, the designs on it, the buildings on it and its
  permitted massing.
- **Built building**: the design that affects it.
- **Permitted massing**: its parcel.

Neighbours join the instances already present without displacing them: what the click hit keeps
its place and fields, and a neighbour only fills what is missing. `click-stack-neighbours.js`
holds the rule; `ClickStackHits.neighbourLookups` supplies the app's lookups, and a view can
replace one with its own (the model view reads buildings from its scene).

## Rows, relationships and expansion

- On desktop, the stack displays the selected level and the nearest available level above and below it.
  Selecting a neighbouring row moves this window; the complete inventory remains available.
  Observed-building inspection instead shows Building and its cadastral parcel: source buildings
  are baseline context, not members of a surrounding Plan. An explicit design impact appears as an
  **Affected by design** link inside the building card; overlap alone does not establish that link.
  Selecting the link opens the design's own authored context. Leaving a design for a source building
  disposes its membership lookup, including pending responses, so refresh cannot restore stale Plans.
  Every displayed section has a clickable header. Expanding a section collapses the others;
  at most one is expanded. There is no coordinate footer.
- Parallel action buttons share their row's width equally, including pairs and triples.
  Relationship lists show one item per row; long labels stay on one line with an ellipsis.
- Desktop navigation and feedback stay centred on the viewport when inspection opens. The
  right column can extend to the bottom edge while it clears those controls horizontally; where
  they overlap, its maximum height stops above the highest visible control with a small gap.
- Collapsed headers are one row: the object kind followed by its selected name or parcel ID,
  truncated with an ellipsis. The cadastral header has no copy button.
- A collapsed Design header shows only “Design” and the selected name on one line, with no
  collection count or type badge. The expanded header shows the authored type as a prominent
  colored icon pill, repeated in its details; its name may wrap below the type row. Color
  supplements the type text and icon; it does not indicate publication or approval.
- Relationship groups are explicitly labelled lists **inside the expanded card body**.
  Their links fill the card's width; they do not create horizontal scrolling. A group navigates
  related objects, never siblings of the object already selected:
  - A plan offers its included designs. An agreement references exactly one Plan revision;
    it has no independently authored design membership.
  - A design offers the plans and agreements it belongs to, plus its affected parcels or formed land.
  - A formed parcel offers its producing design and source cadastral parcels.
  - A source parcel can offer its formed pieces or designs on that parcel.
  Each group has its own content tab, including when it has only one target.
  Missing or off-screen targets remain useful links. A related item is an object
  list item (design-language.md, "Object lists"): hovering it outlines its object, clicking it keeps
  that outline (framed when out of view in 2D; the model view's camera stays), and its arrow button
  selects and expands the object's section, or opens a plan's design that is not in the stack.
  Related items are one per row at every width. A formed piece is named `<root parcel> #<n>`
  (`_parcelIdLabel` in proposal-parcel-identity.js), never by its runtime id, whose token is the
  producing design's id (a full CID for a published design).
- A plan's Designs tab contains its members. Short content fits its rows; long lists scroll
  within the available body height. Actions have their own content tab.
- **Agreements sit above Plans, followed by Designs.** Plans are discovered for the exact design
  revision; agreements are loaded only for the selected exact Plan CID. Switching Plans replaces
  the agreement choices, and stale responses from the previous plan are discarded. Agreement
  sections host the full scrollable agreement properties and actions. Inspecting
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
  - Selecting a Design from a Plan resolves that design's current live output parcels and original
    cadastral inputs without requiring another map click: the neighbours rule at work. The design's body pieces or layout plots
    are shown, excluding remainder land that shares producer metadata. Its Source parcels metric
    counts cadastral inputs. Switching peer designs replaces this
    ground context while retaining the plan and design choices. Unapplied designs have no live
    formed outputs; inspecting them does not create any.
  - Plan: meaning, name, included designs, combined map highlight, Share plan and Create agreement.
    Agreement: the full agreement record, including decision/allocation terms, publication,
    approvals and other applicable actions, with the inherited plan extent. There is no separate
    properties dock. Editing opens the existing modal and returns to this section.
    Overview contains the plan, designs, publication and applicable voting/chain controls. Input
    parcels, Output parcels, Persons and Rules have their own tabs; community agreements omit the
    allocation and person tabs. Tabs retain their selection through refresh. Hover/focus previews
    spatial rows, and clicking frames and highlights them without leaving the agreement. Person
    rows inspect their contributed and allocated land. Hash-only outputs remain non-spatial.
  - Design: the proposal's actions panel itself (2026-10-23), without its own − and ×: an
    Info tab (name, rung badges, type, author, parcel count and one area), a Details tab
    (land and ownership, verification, the record), and a separate Actions tab; related
    plans have their own tab. A parcel layout's panel has Overview (name,
    badges, author, site area), Input parcels (the cadastral parcels it takes) and Output parcels
    (the plots it forms) instead, and no Share: its agreement publishes it. Its 2D section adds no
    parcel links of its own, since those tabs list them. Other designs, and every design in the
    model view's section (which has no panel), list the parcels as Input parcels and Output
    parcels tabs, in that order. The panel re-renders when the design's formed parcels change, so
    a layout opened before it has replayed onto the map does not keep a count of 0. **Add to plan** heads
    the Actions tab in the map and model view; the hosted panel's footer does not repeat it. Starting Before / after from it folds the stack to its
    rows (the card stays hosted, so the comparison keeps running); a row click unfolds it.
- A proposal opened from a list, shared link, restored selection, or just placed (an editor's Done,
  a one-click structure, the create dialog) opens the
  stack at a point inside it with its Design section expanded, instead of a card of its own. No
  click opened that spot, so the first click on the design is a new click, not a close.
  - Built: the building record. Permitted: the massing inspector.
  - Cadastral or formed parcel: the parcel info panel. The cadastral section heading is
    **Cadastral parcel · <reference>**; it replaces the panel's duplicate identity heading and
    the former area/ownership summary. Source and formed-ground provenance remains in Info.
    **Select multiple parcels** (Manually / Detect block) sits in Actions, before
    **Custom site**. Custom site starts an editable working boundary; it does not change the
    parcel layout and remains available for drawing a design over that boundary.
    **Actions · Info · Tools** are the parcel panel tabs promoted into the content bar. Actions
    opens first; each object remembers its selected content tab. Info explains source and formed
    ground provenance. Actions offers selection of current parcels for further design work. Source selection always
    outlines the immutable repository geometry, including while collapsed.
    The panel's Proposals tab is replaced by the relationship Designs tab when that list is present. The selected-set section retains Proposals for the whole
    set. Parcel information and proposal actions open only inside the click panel; there is no
    automatic companion parcel panel beside a selected proposal. Hosted Built/Permitted inspectors have no close
    button: their section heading collapses them or another section takes over.
- The selected object has a pulsing map outline, retained while collapsed and protected from hover.
  Reduced motion uses a steady border. Desktop highlights the selected card and circular icon
  node, with short connectors behind the cards. Mobile highlights the selected object tab.
- **Memory:** the kind of the expanded section is remembered (also across reloads). The next
  click expands that kind if it exists there, otherwise the topmost section.

## Code

- `frontend/js/click-stack/click-stack-model.js`: pure ordering, counts, default instance,
  remembered kind, close-or-switch decision (unit tested, no DOM).
- `frontend/js/click-stack/click-stack-hits.js`: collects the hits at a point from the live
  layers (drill stack for designs and parcels, building layers, planning items, agreements), and
  supplies the neighbour lookups.
- `frontend/js/click-stack/click-stack-neighbours.js`: the pure neighbours rule (unit tested).
- `frontend/js/click-stack/click-stack-navigation.js` and `css/click-stack-navigation.css`: shared
  object tabs, promoted content tabs, per-object page memory and explicit mobile sizing.
- `frontend/js/click-stack/click-stack-panel.js`: the panel; hosts the existing panels
  (planning inspector, proposal card, parcel info panel) inside the expanded section.
- In Manual or Shift multi-selection, **Selected parcels (N)** replaces the point-specific
  sections. It shows measured total area and hosts the parcel Design / Info / Proposals / Tools tabs for the
  whole selection through the shared content bar. Clear keeps selection mode active, including
  an empty selection; Done exits selection mode and retains the selected parcels. The header can
  fold while map clicks keep changing the selection. There is no bottom selection tray. Detect
  block and Custom site remain available in Actions.

## 3D model view

The 3D model view has its own click stack (`frontend/js/three-click-stack.js`, user decisions
2026-10-23): the 2D stack's frame and card/row/relationship look (`#click-stack, #three-click-stack` share the
rules in `css/map.css`), with what a click in the scene stands on. Desktop section cards float
over the scene; mobile uses the shared object tabs, content tabs and sizing controls. The stack
closes on Escape, a click on nothing, another selection, or the mobile close button. It replaced the floating top-left parcel /
"Proposal info" panel.

- Sections, top to bottom: **Built** (the clicked building, and the existing buildings standing on
  the parcel), **Agreements**, **Plans**, **Design** (the clicked proposal, or the proposals on the
  parcel), **Permitted** (the clicked massing, or the parcel's cached massing), **Formed parcel**
  (live ground a design formed or a road cut from a parcel), **Parcel** (the one parcel).
- The clicked thing's section opens; one section is open at a time. Ground under a click is a
  formed parcel when a design produced it or it is a piece cut from another parcel, else a
  cadastral parcel.
- The neighbours rule applies here too: the selected object's own references add the sections
  above and below it, whether the stack was opened by a scene click, a list, a link or a plan.
- A repeat scene click on the same object or map spot keeps the stack and re-opens that object's
  own section when another one had been expanded; it never steps through sections. This works
  independently of double-click speed. A different object starts with its own section; a click
  on nothing or Escape closes the stack. Header clicks select a section directly. Scene clicks,
  header switches and refreshes preserve the camera and keep the scene in context. A stack opened
  from a list or link (Lists, a relationship link, a plan or agreement panel, an editor
  finishing, a restored selection) starts a fresh scene-click sequence and frames its
  object when it is outside the map area the panels leave visible or too small to make out;
  an object already in view keeps the camera (`framingNeeded` in `click-stack-model.js`).
- In Lists, a row's title only shows it on the map: the design, or a plan's or agreement's designs,
  outlined and framed in the area the sheet leaves visible (the model view moves its camera), with
  the list left open and nothing selected. The row's **Open** button selects it as described above,
  closing the list (`lists-panel.js`).
- The expanded card's header has a **Focus** button (crosshairs, “Show on map”) for every
  section with a shape: it highlights the object and always fits the map to it, clear of the
  stack. Ground has no Focus button. The model view's stack has the same button, which moves
  the camera in or out over the object while keeping heading and tilt.
- Expanded cards fit their content. On desktop, long content scrolls within the dock height after
  reserving room for neighbouring headers. Mobile uses the viewport limits described above.
- Design open: the composition stays visible and the section shows the whole design's info
  and Built / Planned / Proposed figures with the price sliders. **Proposal actions** switches to
  the same design in the 2D click panel. Restoring a design or entering through a shared model link
  opens this section; authored selections never open the Buildings and massing inspector.
  Parcel open: the same figures for the one parcel.
- Built and Permitted host the Buildings and massing inspector.
- Selecting an observed building shows only Built and its cadastral parcel, with the same explicit
  **Affected by design** links as 2D. The complete hit inventory remains available for navigation.
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
selection colour, collapse behaviour, repeat-click retention and Escape dismissal. Selecting
an object retains the camera and surrounding composition in both views; only the Focus button
moves it. Building/source
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
