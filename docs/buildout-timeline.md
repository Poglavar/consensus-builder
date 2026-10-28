<!-- Open plan: construction windows on plan members, a map time control, and under-construction rendering. -->
# Build-out timeline

A plan can say when each of its designs is built. The map gets a time control that moves one date
back and forth; every scheduled design shows as not started, under construction or built at that
date. This replaces the retired list timeline (`epochYear` on a design).

## Decisions

- **Dates belong to the plan, not the design.** The same design can be built faster or slower in
  another plan. An agreement shows the schedule of the plan revision it references and has no
  schedule of its own; its deadline stays the decision deadline, unrelated to construction.
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
  browser, the server routes and MCP already share.

## Buildout state

A new pure module, `frontend/js/plans/buildout-schedule.js` (UMD, DOM-free, headless tests):

- `stateAt(window, month)` → `{ phase: 'planned' | 'construction' | 'built', progress }`. Progress
  is linear over the window's months: `(month − start + 1) / (end − start + 1)` during construction,
  0 before, 1 after.
- `stateMapAt(plan, month)` → per-design state; unscheduled members are `built` at every date.
- `range(plan)` → first start and last end, for the slider bounds and the plan's Gantt strip.
- Demolition and clearance parts of a design take effect at its start month; new fabric follows
  progress.

## Interface

**Plan components (the plan's design list in Lists → Plans).** Each row gets an optional
"Construction" month range (two `<input type="month">` fields). A Gantt strip above the list shows
every window on one axis and opens the row on click. Saving goes through the existing plan revision
flow. The agreement view shows the same strip read-only.

**Time control on the map.** A clock button in the map controls opens a slider over the shown plan's
range (or its agreement's plan), month steps, with play and step buttons and the current month as a
label. The selected month is in the URL as `when=YYYY-MM`, so a shared link opens at that moment.
Without a schedule in view the button is absent. Closing the control returns to "now" (everything
built).

**2D.** Planned: outline only, faded. Under construction: the design's fill with a hatch pattern and
a crane icon at its label point. Built: normal rendering. Hatch and icon colours come from theme
tokens in `frontend/css/tokens.css`.

**Model view (3D).**

- Buildings: floors up to `progress × floor count`, the top built floor wrapped in a scaffold mesh,
  one crane per site (shared instanced model). Progress 0 within the window shows an excavation pit
  at the footprint.
- Roads: the lane surface laid along the share of the corridor length given by progress; the
  remainder shows as graded earth.
- Parks, squares and lakes: ground cover fills with progress; trees appear at the end month.
- Rebuilds happen only when a design's phase or built floor count changes, never every slider tick,
  and stay within the model view's frame budget.

## MCP parity

- `ugt_inspect_plan` / `ugt_get_plan` return `schedule`.
- `ugt_edit_plan` and `ugt_draft_plan` accept `schedule` (the same validation as the browser);
  `ugt_validate_plan` reports schedule errors.
- Preview links carry `when=` when the caller asks for a moment.
- No new tool: scheduling is a plan edit.

## Retiring the design timeline

Remove `epochYear` everywhere it remains, in the same change as milestone 1:
`frontend/js/proposals/epoch.js`, the create-dialog year field (`dialog-create.js`, `create.js`),
`setProposalEpochYear` in `proposals/data.js`, the list filter in `proposals/list-ui.js`, the
`epoch_year` column reads in `backend/routes/proposals.js` and `backend/proposals/serializer.js`,
the year buckets in `proposals/plan-yield.js` (replaced by schedule months), the
`.proposal-epoch-timeline` styles, `backend/test/proposal-epoch.test.js` and the epoch case in
`e2e/tests/proposal-button-controls-extra.spec.ts`. The vocabulary entry "Display year" becomes
"Construction window".

## Milestones

1. **Schedule and time control.** `plan/v1` schedule, `buildout-schedule.js` with headless tests,
   plan-row editing and the Gantt strip, the map clock with `when=`, 2D hatching and crane icon,
   MCP parity, `epochYear` retired, vocabulary updated.
2. **Partial builds in the model view.** Floor-limited buildings, scaffold and crane models,
   excavation, partial roads and parks; performance checked against the current model view.
3. **Simulated build-out.** A seeded generator over permitted envelopes: per-parcel start month
   drawn from a yearly start rate, duration from built floor area; `buildout=<seed>` in the URL; the
   same clock and rendering, labelled as a simulation.

## Open questions

- Whether a published plan's schedule needs a stated basis (estimate, contract, permit) beside the
  months.
- Whether the clock should also show the agreement's decision deadline as a marker on the slider.
