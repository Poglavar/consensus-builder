<!-- Contract: construction windows on plan members, the map's time control, under-construction rendering and simulated build-outs. -->
# Build-out timeline

A plan can say when each of its designs is built. The map gets a time control that moves one date
back and forth; every scheduled design shows as not started, under construction or built at that
date. Designs carry no dates of their own.

## Decisions

- **Dates belong to the plan, not the design.** The same design can be built faster or slower in
  another plan. The timeline reads only plan dates; agreements, their deadlines and their views play
  no part in it.
- **A window is just its months.** No stated basis (estimate, contract, permit) is recorded.
- **Month precision.** A window is a start month and an end month, both inclusive (`YYYY-MM`).
- **The time control only displays.** Moving it never applies, unapplies or replays anything; replay
  order stays the formation and dependency order (see Replay in the [vocabulary](vocabulary.md)).
- **Simulated build-out is a scenario, never a record.** A seeded, repeatable build-out of what the
  urban rules permit is shown as a simulation and never stored in a plan or agreement.

## Record contract

`plan/v1` gains one optional key, `schedule`, keyed by member design CID:

```json
{
  "schema": "plan/v1",
  "title": "Borovje north",
  "designCids": ["bafk…a", "bafk…b"],
  "view": { "…": "…" },
  "schedule": {
    "bafk…a": { "start": "2027-03", "end": "2028-10" },
    "bafk…b": { "start": "2029-01", "end": "2029-06" }
  }
}
```

- Every key must be a member of `designCids`; `start <= end`; months between 2026-01 and 2966-12
  (the old epoch range). Members without an entry are unscheduled.
- `schedule` is omitted when empty, so an unscheduled plan keeps its canonical content and CID.
- Changing a window is a plan edit: it creates a new immutable plan revision and link, like
  changing the title or membership. Existing agreements keep the revision they reference.
- Validation lives in `frontend/js/plan-record.js` (`validate`, `jsonSchema`, `create`), which the
  browser, the server routes and MCP share. The JSON Schema marks the rules it cannot express
  (membership, range, order) with `x-ugt-plan-members`; `semanticRules.scheduleError` checks them.
- A plan revision keeps the windows of the members it keeps: `PlanComposition.create` takes the
  base revision's schedule, `PlanComposition.withSchedule` changes only the schedule, and portable
  plan files carry it (`PlanFile.create({ schedule })`).

## Buildout state

`frontend/js/buildout-schedule.js` (UMD, DOM-free; `backend/test/buildout-schedule.test.js`):

- `stateAt(window, month)` → `{ phase: 'planned' | 'construction' | 'built', progress }`. Progress
  is linear over the window's months: `(month − start + 1) / (end − start + 1)` during construction,
  0 before, 1 after.
- `stateMapAt(plan, month)` → per-design state; unscheduled members are `built` at every date.
- `range(plan)` → first start and last end, for the slider bounds and the plan's Gantt strip.
- `builtFloors(floors, state)` → floors standing at a state; `bars(schedule)` → Gantt bar offsets
  and widths as shares of the range.
- Demolition and clearance parts of a design take effect at its start month; new fabric follows
  progress.

## Interface

**Construction schedule dialog** (`PlanDialog.schedule`, `frontend/js/plan-dialog.js`). It lists
the plan's members, each with a start and an end month (`<input type="month">`) and a clear button,
under a Gantt strip of every window on one axis; a bar focuses its row. Dates are optional per
member: members without dates are named in a "Without dates" row under the axis and stand as built
at every month. Invalid windows block
saving. Saving makes a new plan revision, which the click stack then shows. The dialog opens from
the click stack's plan section (Construction schedule, beside Share plan and Create agreement; the
section also shows the read-only strip), from a plan row in Lists → Plans, and from plan details.
Its Simulate build-out button starts a simulation (below).

**Time control on the map** (`frontend/js/buildout-clock.js`, `window.BuildoutClock`). An hourglass
button in the top-right map cluster appears while a plan with a schedule is in view: a plan shown in
the click stack, opened by a `/plans/<cid>` link or opened as a private draft preview. It opens a
card at the bottom centre with the plan's title, step back, play/pause, step forward, the month, a
month slider over the plan's range and a count of designs under construction, not started and
without dates (shown as built). A plan with no dates at all has no hourglass. The
month is in the address as `when=YYYY-MM`; outside a `/plans/<cid>` address `timeline=<cid>` names
the plan (read from this browser's plans, else from the server). Closing returns to now. Every
change fires the window event `buildoutchange` (`{ month, planCid, simulated }`); renderers read
`stateOf(proposal)`, `stateOfBuilding(proposal, index)` and `unbuilt()`.

**2D.** An overlay pane (`buildout-pane`, over the designs) draws each applied, scheduled member that
is not built. Planned: its footprint veiled to a dashed outline. Under construction: its footprint
hatched (the `#buildout-hatch` SVG pattern) with a crane at its label point. Built: nothing, the
design as applied. Colours are the `--cb-buildout-*` tokens in `frontend/css/tokens.css`; the
styles are in `frontend/css/buildout-clock.css`.

**Model view (3D)** (`frontend/js/three-mode.js` with `frontend/js/three-buildout.js` for scaffold,
crane and earth materials; the pure part rules are `frontend/js/buildout-parts.js`, tested in
`backend/test/buildout-parts.test.js`, and the browser checks in `e2e/tests/buildout-model.spec.ts`).

- Planned: the design is left out of what the model view draws, for display only. Its buildings,
  road, park, square or lake are absent, and the context it demolishes or clears stands again
  (existing buildings, cleared trees). Nothing is unapplied.
- Buildings under construction: floors up to `builtFloors`, the top built floor wrapped in a
  scaffold, one crane per site (four shared instanced meshes for every crane). With no floor built
  the footprint is an excavation pit in an earth margin. The design's open ground is earth until
  built. In a simulation each urban-rule building follows its own window (`stateOfBuilding`) and has
  its own crane.
- Roads: lane surface, markings and decoration are laid along the built share of the corridor
  length, in tenths; the rest is earth at full width. Pavement fills and junction corners come at
  the end month.
- Parks, squares and lakes: earth, with lawn, paving or water spreading from the west by area share
  in tenths; trees, furniture, ponds, fences and fish come at the end month.
- A month redraws only the designs whose phase, built floors per building or tenth changed, and
  only their layers; the existing buildings are rebuilt only when a start month changes what is
  demolished. Closing the time control gives back the normal scene.
- Not drawn by state: the parcel ground under a planned road (it is the 2D fabric's applied
  state), vacant plots, invisible pick surfaces of planned designs, and uploaded models (extruded
  from their footprint while under construction). Photo view draws a road's earth flat.
- A month that changes what is demolished still costs a few 50–95 ms tasks while the existing
  buildings rebuild; other months stay under 50 ms.

## MCP parity

- `ugt_get_plan` returns the plan content with its `schedule`; `ugt_inspect_plan` returns
  `schedule` and each design item's `construction` window.
- `ugt_draft_plan` and `ugt_edit_plan` take `schedule`: `{ [design CID or design ref]: { start, end }
  | null }`, merged over the current windows (null clears one), validated by `PlanRecord`. Windows
  follow designs an edit revises (edits, replacements, roads joined to others); a removed member's
  window goes with it. A key that names no member is refused (`schedule-member-not-found`).
- `ugt_draft_plan`, `ugt_get_plan` and `ugt_edit_plan` take `when` and `buildout` for the preview
  link (`when=`, `buildout=`).
- No new tool: scheduling is a plan edit. Tests: `backend/test/mcp-named-plans.test.js`,
  `backend/test/mcp-preview-links.test.js`.

## Simulated build-out

`frontend/js/buildout-simulation.js` (pure; tests in `backend/test/buildout-schedule.test.js`). The
sites are the plan's undated members: an urban rule (a design with `geometry.ruleMassing`, one
building per parcel) contributes each building, any other member itself. Each site draws from its
own stream (seed and site key), so adding a site never moves another. Its start month waits from
the current month with a constant hazard: 25% of the sites still waiting start within a year,
capped at 30 years. Its duration is 6 months plus 3 per 1000 m² of floor area (footprint area ×
floors), capped at 48. Members the plan dates keep their windows; a rule member's window spans its
buildings'.

`BuildoutClock.simulate(plan, { seed })` shows the scenario with a Simulation badge and a dice
button for another seed; the address carries `buildout=<seed>` beside `timeline=` and `when=`, and
such a link reopens the same scenario. Closing ends the simulation, and the plan's own dates, if
any, stay in view. Nothing is stored.

## Retired

The per-design year (`epochYear`) and the list timeline are gone from the app and the API. The
`proposals.epoch_year` column remains in the database, unread; dropping it needs its own two-phase
change.
