# Effects on neighbours

What a design does to the plots around it: sunlight on their gardens, sky seen from their walls,
the angle tests from their windows and how close a facing wall comes, before the design and after it. The readings are advice, like
the [Permitted check](vocabulary.md#permitted-check): they never stop a design being saved.

How a reading is measured is code; whether a place uses it and its thresholds are configuration:
a rule set's `neighbourGuides` in `frontend/data/planning-sources.json`, which a city names in
`planning.ruleSetIds`. A city whose rule sets state no guides gets no Effects section or buttons.

```json
"neighbourGuides": {
  "label": "BRE, Site layout planning for daylight and sunlight (BR 209, 2022); 21 m between facing windows in local design guides",
  "binding": false,
  "note": "BRE: a reduction beyond a guide is likely to be noticeable; within it, unlikely. …",
  "garden": { "date": "03-21", "hours": 2, "share": 0.5, "ratio": 0.8 },
  "sky": { "percent": 27, "ratio": 0.8 },
  "noSky": { "ratio": 0.8, "workingPlaneM": 0.85, "rooms": ["living", "kitchen", "bedroom"] },
  "sunlight": { "percent": 25, "winterPercent": 5, "winter": { "from": "09-21", "to": "03-21" }, "ratio": 0.8, "lossPercent": 4, "facingDeg": 90 },
  "angle": { "degrees": 25, "then": "sky" },
  "splay": { "degrees": 45, "then": "sky" },
  "distance": { "metres": 21 }
}
```

- `garden`: beyond the guide when under `share` of the garden gets `hours` of sun on `date` (MM-DD),
  and under `ratio` times the share before.
- `sky`: beyond the guide when the vertical sky component is under `percent`, and under `ratio`
  times before.
- `noSky`: the no-sky line (BRE BR 209 2.2.10–2.2.11, Appendix D), measured on demand: in each room of
  the `rooms` kinds, the share of its working plane (`workingPlaneM` above the floor) that sees sky over a
  window head; beyond the guide when it falls under `ratio` times before. BRE applies it where room
  layouts are known; here they are the suggested layouts of the plot's buildings (estimates, and said so).
- `sunlight`: sunlight to a window over the year (BRE BR 209 3.2), for walls facing within
  `facingDeg` of the noon sun (due south north of the equator). Beyond the guide when the window
  gets under `percent` of the year's probable sunlight hours and under `ratio` times before, or
  under `winterPercent` in the `winter` months (MM-DD, `from` inclusive) and under `ratio` times
  its winter before, and loses more than `lossPercent` of the year's. Needs the place's sunshine
  records (below); without them it is not measured, and the section says so.
- `distance`: beyond the guide when a facing wall comes closer than `metres` (and closer than before).
- `angle`: crossed when the design rises more than `degrees` above the horizontal in front of a
  window, in the section square to its wall (and higher than what it replaces).
- `splay`: crossed when a building beside a window crosses both lines at `degrees`: in plan, from
  the window to its wall; in elevation, falling from the building's top corner nearest the window
  (the window lies under it).
- `then` names the detailed reading a test is a first check for (England: BRE's 25° and 45° tests
  lead to the sky reading). A crossed test with its `then` reading measured is marked as a first
  check, in the info colour, and grades nothing: the plot's group is that of its graded readings,
  and a plot whose only change is a crossed first check (its detailed reading unchanged) is not listed.
  Without `then`, crossing the test is beyond the guide.
- A reading left out is not measured or shown. `label` names the source and `note` what the
  standard says its grades mean, both in "What the guides are";
  `binding: true` says a design beyond a guide is not permitted, otherwise the guides are advice.
- Only `gb-eng-planning` (England) states guides today.

## Where it shows

- **Freeform building editor:** an "Effects on neighbours" tab beside the Building tab (drawing
  tools and the Permitted check), measured again whenever the building changes; the tab shows the
  number of affected plots and spins while it measures.
- **A saved design:** an "Effects on neighbours" button in the map's Design card, and on its card
  in Lists → Designs. A design is measured as its one-member plan, as Compare designs does.
- **A saved plan:** the same button on the plan's Stats and analysis page in the map's plan panel,
  and on its card in Lists → Plans.
- **An agreement:** the agreement editor's Neighbours tab measures the agreement's plan the same
  way and adds ticked plots as affected parcels, each with a snapshot of its changed readings
  (`NeighbourEffects.snapshot`: kind, before, after, the guide's value, grade) and the rights they
  are evidence of (garden → garden limit, sunlight → sunlight, sky, no-sky line, angle and splay →
  daylight, facing distance → privacy). See [agreement-editor.md](agreement-editor.md#affected-neighbours).

Each lists the affected plots in three groups, each by its largest loss first, named by compass
direction and distance: **beyond a guide** (red: under both the guide's level and its allowance),
**under a guide's level, within its allowance** (orange: within the guide) and **still meets the
guides** (green). A plot shows an icon per reading that changed (sun: garden sunlight, sun behind a cloud: sunlight to a window over the year, cloud: sky, chevron: angle,
set square: splay, arrows: facing distance) in its grade's colour, and the readings in words below. Filter buttons narrow the list to one kind of
reading, sorted by that reading's loss. A plot's name highlights it on the map while hovered or
focused; a click keeps it highlighted and brings it into view. The other way round, a plot on the
2D map lights its list entry while hovered and a click selects it in the list. The heading spins while the section
measures; while it re-measures after an edit, the last result stays. "What the guides are" explains
the groups. The plots are coloured on the map, red, orange and green the same way, and outlined on the ground
in the 3D model view (the pointed-at plot in a wider line); closing the click stack or the editor
clears both. In 3D a click on a name keeps the highlight but does not move the camera.
While the editor shows the Effects tab, the 3D model view makes the design's own shadow stand out:
a share of the sun's light (`EMPHASIS_SHARE` in `three-sun.js`, 45%) comes from a second light in
the same direction that only the design blocks, so its shadow keeps full darkness while every other
shadow is lit by that share. The second light's shadow map is drawn from the design's meshes alone.

**Room daylight on demand.** Each listed plot with buildings has a row "Room daylight (no-sky line),
from estimated layouts" with a **Calculate** button (it spins while it works): the plot's buildings
are laid out, their rooms measured, and the result joins the plot's readings, its grade and the list's
order; a plot where no room loses sky says how many rooms were measured.

**Drawings.** The plot pointed at (hovered, or else the one clicked) has its readings drawn, on the
2D map as their ground trace and in 3D in place: the window each reading is taken at (a yellow dot);
for the sky, rays from the window to the design's top edge where it now stands above all else; for
the angle test, its plane rising from the wall at the guide's angle and the line from the window to
the top of what the design puts in front of it; for the splay test, the plan line on the ground and
the elevation line on the wall; for the facing distance, the line between the nearest points; for
the garden, the points that lose their hours of sun. Guide lines are dashed, what the design does
is solid, in the reading's colour.

**Loss** is the share of a plot's sunlit garden or of its sky that it loses, or for a facing wall
how far it now stands inside 21 m, as a share of 21 m.

**What the groups mean.** The groups state only what a guide defines. What the standard says a
grade means is the guides' `note` in the configuration, shown under "What the guides are" (England:
BRE counts a reduction beyond a guide as likely to be noticeable, within it as unlikely). Where a
place's guides are binding, beyond a guide reads "not permitted".

## Readings

| Reading | Measured at |
|---|---|
| Garden sunlight | the plot's land outside its buildings, on a grid of at most 200 points |
| Sky from the facing wall | each wall of the plot's buildings that faces the design, 1.6 m up (CIE overcast sky) |
| Room daylight (no-sky line), on demand | rooms of the guide's kinds in the suggested layouts of the plot's buildings (the shared planner with its rooms, entrance on the longest facade), working-plane points every 0.5 m (at most 400 a room); a point sees sky when a sight line over its window's head (sampled at its ends and middle, on the outside face) clears everything outside the room's own building. Rooms on the site, and windows with none of the design in front of their wall, are left out |
| Sunlight to a window over the year | the middle of each wall with some of the design in front of its plane and facing within the guide's angle of the noon sun, 1.6 m up; the sun every 20 minutes of every 4th day, each position weighted by its month's chance of sunshine |
| Angle from a facing window | windows every 3 m along those walls, 1.6 m up, square to the wall |
| Splay beside a window | windows every 3 m along walls with the design in front of their plane, for buildings beside the window (not in front of it) starting within 3 m of the wall's plane |
| Nearest facing wall | the same walls, to the nearest wall of the design |

- "Before" is the buildings standing now; "after" takes away those on the design's parcels and adds
  the design's buildings.
- Smaller changes than 1 percentage point of garden share, sky or sunlight hours, 0.5 m of
  distance, 0.5° of angle or 0.1 m of splay depth are not listed.
- Window positions are not known: the angle tests take the worst of points every 3 m along a wall. A wall against another building (a terrace's party wall) has no sky or distance reading.
- Plots are looked at within 4 times the tallest new or removed building, at least 30 m and at most
  200 m; shadows and sky are cast by buildings within 200 m of each plot.
- The sun comes from SunCalc at 10-minute steps over the garden guide's day at the plot's latitude.
- Ground is flat: terrain is not read.

## Sunshine records

Probable sunlight hours are, in BRE's words (BR 209 3.2.4), the hours the sun is expected to
shine on unobstructed ground, allowing for the place's average cloudiness from sunshine
probability data. `frontend/data/sunshine-records.json` holds stations' long-term mean sunshine
hours per month, each with its source, period, licence and `coverage.bbox`; the station whose
coverage holds the design is used. Each sun position is weighted by its month's recorded sunshine
hours over the hours the sun is up that month, so open ground gets the station's total, and a
window's share is the weight of the positions in front of its wall that clear what stands in that
direction (swept every 2°, as the sky is). BRE's own indicators (Appendix A) are drawn for three UK
latitudes from Met Office data; this calculation follows its definition with the place's own
records, so results can differ from an indicator count by a few points. Today: Heathrow, Met Office
station data 1991–2020, for Greater London.

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
- **Agents:** MCP has no effects tool yet; agents can read Permitted context but not these readings.
