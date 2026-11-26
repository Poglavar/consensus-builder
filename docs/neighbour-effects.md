# Effects on neighbours

What a design does to the plots around it: sunlight on their gardens, sky seen from their walls,
and how close a facing wall comes, before the design and after it. The readings are advice, like
the [Permitted check](vocabulary.md#permitted-check): they never stop a design being saved.

## Where it shows

- **Freeform building editor:** an "Effects on neighbours" section under the Permitted check,
  measured again whenever the building changes.
- **A saved design:** an "Effects on neighbours" button in the map's Design card, and on its card
  in Lists → Designs. A design is measured as its one-member plan, as Compare designs does.
- **A saved plan:** the same button on the plan's Stats and analysis page in the map's plan panel,
  and on its card in Lists → Plans.

Each lists the affected plots in two groups, **beyond a guide** and **within the guides**, each by
its largest loss first, named by compass direction and distance. A plot shows an icon per reading
that changed (sun: garden sunlight, cloud: sky, arrows: facing distance), red beyond a guide and
amber within, and the readings in words below. Filter buttons narrow the list to one kind of
reading, sorted by that reading's loss. A plot's name highlights it on the map while hovered or
focused; a click keeps it highlighted and brings it into view. The heading spins while the section
measures; while it re-measures after an edit, the last result stays. "What the guides are" explains
the groups. The plots are coloured on the map, red and amber the same way, and outlined on the ground
in the 3D model view (the pointed-at plot in a wider line); closing the click stack or the editor
clears both. In 3D a click on a name keeps the highlight but does not move the camera.

**Loss** is the share of a plot's sunlit garden or of its sky that it loses, or for a facing wall
how far it now stands inside 21 m, as a share of 21 m.

**What the groups mean.** The guides are advice that planning authorities apply flexibly (in
England, the BRE guide *Site layout planning for daylight and sunlight*, 2022, and the 21 m between
facing windows many local design guides use), not law. Beyond a guide, the neighbour is likely to
notice the loss and an authority will expect the design to justify it; within the guides, the loss
does not count against the design. No reading forbids a design: binding limits are the Permitted
check's.

## Readings

| Reading | Measured at | Beyond the guide when |
|---|---|---|
| Garden sunlight | the plot's land outside its buildings, on a grid of at most 200 points | under half the garden gets 2 hours of sun on 21 March, and under 0.8 times the share before |
| Sky from the facing wall | each wall of the plot's buildings that faces the design, 1.6 m up | the vertical sky component (CIE overcast sky) is under 27 %, and under 0.8 times before |
| Nearest facing wall | the same walls, to the nearest wall of the design | under 21 m, and closer than before |

- "Before" is the buildings standing now; "after" takes away those on the design's parcels and adds
  the design's buildings.
- Smaller changes than 1 percentage point of garden share or sky, or 0.5 m of distance, are not
  listed. A wall against another building (a terrace's party wall) has no sky or distance reading.
- Plots are looked at within 4 times the tallest new or removed building, at least 30 m and at most
  200 m; shadows and sky are cast by buildings within 200 m of each plot.
- The sun comes from SunCalc at 10-minute steps over 21 March at the plot's latitude.
- Ground is flat: terrain is not read.

## Heights

Neighbours' heights are the height survey's where one covers them (`frontend/data/height-surveys.json`,
the Environment Agency in England), else their source's, else the 3D view's estimate; the section
says which survey it used and how many heights are estimates. New buildings use the design's own
heights.

## Code

- `frontend/js/planning/neighbour-effects.js`: the readings, pure (unit-tested in
  `backend/test/neighbour-effects.test.js`).
- `frontend/js/planning/neighbour-effects-worker.js`: runs them off the page's thread.
- `frontend/js/planning/effects-advisor.js`: gathers plots, buildings and heights from the map,
  renders the section and the map colouring (`backend/test/effects-advisor.test.js`).
- `frontend/js/ui/plan-analysis-controls.js` `effects`, `runEffects`, `designPlan`: the button for
  plans and designs.

## Open

- **Effects of this plan on a clicked plot:** the affected plot's own panel shows the same readings
  (approved design, step 2).
- **Affected neighbours as parties:** a button in the agreement that adds the affected plots' owners
  as parties with compensation lines (approved design, step 3).
- **Agents:** MCP has no effects tool yet; agents can read Permitted context but not these readings.
