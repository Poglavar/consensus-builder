# Road in a parcel

A road placed into ground already left for it: a Schelling layout's street strips, a cadastral road
parcel, any polygon kept for a street. The ground is the road's land; its lanes are fitted inside and
nothing outside it is taken. v1 reads straight grids; curved and irregular ground is refused.

## The model: a bounded road

A **bounded road** is an ordinary road record whose definition carries `bound: { site }` (a Polygon
or MultiPolygon) and `metadata.mode: 'bounded'`.

- Its land is its site: `corridor-footprint.js footprintIn` returns the site for a bounded
  definition (provenance algorithm `corridor-site/1`); `laneFootprintIn` is what the lanes cut.
- The bound is a definition field beside the OSM document (`corridor-osm-form.js` keeps every
  non-view field), so it survives store, publish and load.
- Only the parcels its land covers by at least 0.25 m² are declared (`road-drawing.js
  roadLandOverlapFloor`, the arrangement's `MIN_PIECE_M2`), so the neighbours it touches are not.
  The arrangement then takes each declared parcel whole.
- Every edit keeps the land (`road-drawing.js runLocalCorridorGeometryUpdate`, and for MCP
  `intent-editing.js reconcile`): the edges are re-filled for the room the edit leaves
  (`refitBounded`), and the edit is refused when a node leaves the site by more than 0.5 m or a
  stretch's lanes need more room than the site gives there (`boundedRoadIssues`). A bounded road
  stays one connected network; an edit that would split it is refused. Its site is never edited:
  a different ground is a new road.

## Cross-section: fixed core, elastic edges

`proposals/corridor-site-fit.js`. The core is every strip between the outer pavements and verges
(driving, bus, rail, cycleway, parking, median); the author chooses it, the edges fill the rest.

- Each side gets a pavement up to 3 m, then a verge with the rest (trees from 2 m, grass below; a
  verge under 0.5 m goes to the pavement).
- The automatic core for a street `w` wide, the Schelling local street generalised: two lanes
  (2.75 m under 10 m, else 3.25 m), 2 m parking each side once 8 m are left beside them, the 20 m
  arterial core (cycleways, two lanes each way, a planted median) from 30 m, one shared 3 m lane
  from 3.5 m, nothing narrower. At 12 m and 30 m this is exactly the Schelling plan's street and
  arterial; `schelling-streets.js localStrips` uses the same fit.
- A chosen core fits when it leaves 1.5 m of pavement each side. The presets offered are the road
  presets (`CORRIDOR_PROFILE_PRESETS`) whose cores fit.
- The lanes run along the middle of the street and fit its narrowest part (the user's rule): an arm's
  room is twice the nearest kerb over the pieces it runs along. A street at the edge of a pool is
  narrower than the plan's street when only part of it lies in the pool, and its road is centred on
  the part that does.

## Centre lines: facing kerbs

`proposals/corridor-site-centreline.js`, in the metric frame:

1. The site's two street directions are the length-weighted mean of its edge directions modulo 90°.
2. A kerb is an edge within 3° of a direction. Each lower kerb is paired with the nearest upper kerb
   above it, exactly, between the vertices' positions: a piece of street 3–60 m wide.
3. Touching pieces of one street are one run; runs on both sides of a crossing or a T opening (no
   kerbs in either direction) are joined when a street of the other direction crosses the gap. A
   street is centred on the band all its pieces share and is at least 1.5 widths long.
4. An end runs on to the centre of a street it meets (a T, a corner), else to the site's boundary.
   Crossings are nodes both streets carry.
5. Nothing found: a lone rectangle is one street along its length; a square is flagged and the
   panel offers "Turn 90°". Streets covering less than 60 % of the site: `not-a-grid`.

`proposals/road-in-site.js` turns the graph into the OSM form the corridor import reads: arms
fitted, ways cut where the fitted cross-section changes, one road per connected part of the site,
each bounded by its own part. Arms are grouped by width (to the half metre) for the lane choice.

## Where it is used

- **Parcel card, Design tab, Transport: "Road in parcel"** (`parcels/ui/proposal-actions.js`, icon
  `cb-icon-road-in-parcel`). It takes the selected parcel, or the union of a multi-selection, and
  refuses ground a road or track already holds. Its on-map panel (`road-in-parcel.js`) previews the
  lanes, offers lanes per street width, "Turn 90°" for a square, and **Place road**.
- **Parcel layout, Schelling**: "Make the street strips roads" (on by default, shown while the
  layout has street-strip plots). On Done the strips' union goes to the design session, which
  fits the roads once the layout is saved and applied (`proposal-editor-shell.js`,
  `RoadInParcel.placeAfterLayout`). Roads applied after a layout take their land out of its plots
  (`proposals/apply/parcels.js`), so the strip plots give way to the roads; the layout record keeps
  only its plots and roads remain road designs.
- **MCP**: `ugt_draft_road` with `parcelIds` or `outline` and no points drafts a bounded road
  (preset or lanes as the core for every street, automatic otherwise); `ugt_modify_design` changes
  its lanes with `set_profile` only; OSM edits re-fit and refuse as in the browser
  ([MCP editing](mcp-editing.md)).

## Open

- Curved and irregular ground: a pruned medial axis (Voronoi of the densified boundary, leaves
  shorter than the local width pruned, node clusters smaller than the local width collapsed into
  one junction) would read any shape; not built.
- A pinch inside an arm narrows the whole arm; splitting the arm there is not offered.
- Ports (the boundary stretches touching other roads) do not yet choose a square's orientation.
