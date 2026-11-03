<!-- Purpose: concise, tool-accessible guidance for navigating the live app and using the parcel layout editor. -->
# App help

## App overview

Use map search to change city and locate places or parcel IDs. Select parcels on the map to inspect them or open the Build tools for buildings, roads, public spaces and parcel layouts. Layers controls switch map information; the view controls switch between 2D, 3D and realistic views. A parcel layout edits the selected ground, while a working plan holds the designs currently applied to the map.

For an agent navigating the map, `ugt_map_view` requests a map view and `ugt_select_parcels` selects exact source parcels; the app applies the returned navigation state. Use `ugt_list_sources` to discover parcel sources for a location.

Help topics:

- `ugt_help { topic: "app" }` — this app overview and topic index.
- `ugt_help { topic: "app/parcel-layout" }` — the parcel layout editor and its controls.
- `ugt_help { topic: "workflow" }` — the agent workflow and available tool families.
- `ugt_help { topic: "editing" }` — MCP authoring and editing behavior.
- `ugt_help { topic: "<tool-name>" }` — the exact schema and instructions for a tool.

## Parcel layout editor

Open **Lay out parcels** from the parcel's Build tools. The right-side panel opens on **Editing** and has three tabs: **Editing**, **New parcels** and **Old parcels**. Use Left/Right Arrow to move between tabs; Home and End move to the first and last tab.

The **Editing** tab contains four starting layouts:

- **Equal plots** divides the pooled ground into equal-area plots. Set the count from 2 to 64; drag the sweep handle to rotate the direction of the dividing lines.
- **Schelling plots** uses the current settings and plot level from the Schelling layer, even when that layer is hidden.
- **Keep existing borders** makes one plot from each input parcel, retaining its source borders. It is unavailable when subdividing a drawn site.
- **Draw freely** keeps the current plots and makes them a manually editable layout.

The count and **Upload GeoJSON** control are beside one another; **Download plots as GeoJSON** exports the current plots. **Before / After** compares the layout with its starting geometry.

The drawing controls work on the map: **Draw plot** makes a plot outline, **Draw a line** splits plots where the line meets existing boundaries, **Erase a boundary** merges the plots on either side, and **Edit boundaries (nodes)** moves or removes boundary nodes. While drawing, **Undo point** removes the last point in the active outline or split line; Finish completes it and Cancel ends that drawing action. The panel's **Undo** and **Redo** move whole layout edits through history.

**New parcels** lists the output plots and their areas. Switching between **Editing** and **New parcels** preserves the layout draft, edit mode and history. **Old parcels** shows the selected input parcels as read-only reference geometry; entering it cancels an active drawing stroke. Returning to either editable tab restores node editing when it was active. Coverage reports whether the new plots cover the pooled land. **Hide controls** folds this panel's content while **Done** and **Cancel** remain in its footer. **Done** saves a valid layout to its design; **Cancel** closes the editor without saving its current changes.
