<!-- Open plan: MCP agents author inside a working plan that acts as their applied map, and learn the consequences of each placement. -->
# Agent working plan

An agent working with a person needs what the map gives the person: the designs already placed,
and what a new one does to them. In MCP that context is a plan. Every authoring call places its
design into a working plan and reports what the placement did or would do, so the agent can tell
the person before anything is published.

## Decisions

- **The plan is the agent's applied map.** There is no server-side "current applied state"; the
  plan is the chosen composition the agent works in, so one arrangement of competing proposals
  never looks official.
- **Always a plan.** Every draft and design edit names the plan it works in. Without one, the call
  starts a new private plan holding just that design, so a single design still has its context.
- **Placement uses the browser's apply rules.** The same modules decide it: `proposals/claims.js`
  (`appliedRivals`, with an explicit Apply's `replaceOccupiedGround`), the corridor junction
  planner, and the formation order that decides which road cuts which ground.
- **Nothing is taken off the plan silently.** When a design stands on ground another plan design
  holds, placement is refused with the designs in the way. The agent asks the person, then retries
  with `displace: true` to take them off the plan, which is what Apply does on the map.
- **Plans stay immutable.** Each placement is a new plan revision with its own `draftRef`; the
  previous revision is the undo.

## Tool contract

Authoring tools take `plan` (a plan `draftRef`, CID, `/plans` link or canonical plan) and
`displace` (default `false`):

- `ugt_draft_road`, `ugt_draft_track`, `ugt_draft_station`, `ugt_draft_building`,
  `ugt_draft_space`, `ugt_draft_parcel_layout`, `ugt_draft_urban_rule` and `ugt_import_design`
  place the new design.
- `ugt_edit_design` and `ugt_modify_design` replace the edited design in the plan when it is a
  member; otherwise they place the revision as a new member.
- `ugt_edit_plan` add, replace, edit and modify operations place their designs the same way, with
  `displace` per operation.

The result keeps its design fields and adds:

- `plan`: the new plan revision (`cid`, `draftRef`, `previewUrl`, `previousCid`), or the unchanged
  plan when placement was refused.
- `placement`: `placed` or `refused`, with `code`, `message` and, for a refusal, `conflicts`.
- `consequences`: what the placement changed in the plan:
  - `removed`: designs taken off the plan by `displace` (`cid`, `title`, `overlapM2`);
  - `junctions`: roads whose junctions changed, as revisions swapped into the plan
    (`beforeCid`, `afterCid`, `title`);
  - `cuts`: ground carved by roads (`designCid`, `roadCid`, `overlapM2`, remaining area), from
    `describeRoadCuts`.

A road no longer takes `corridors`: the plan's roads and tracks are the ones it joins. A station
still names the corridors it attaches to.

## Placement rules

1. Resolve the plan; for an edit, set the edited member aside.
2. A road or track joins the plan's roads and tracks (`joinNewRoads`, or `joinEditedRoad` for an
   edit). Neighbours whose junctions change are replaced in the plan by their revisions.
3. `appliedRivals(incoming, members, { replaceOccupiedGround: true })` lists the members in the way:
   buildings and structures under a building, structure or road; roads under a building or surface
   space; layouts under a layout; overlapping revisions of the same road. A road crossing a park,
   square or lake is not a rival: it cuts through.
4. Rivals without `displace` refuse the placement (`ground-occupied`); with `displace` they leave
   the plan and are listed in `consequences.removed`. An edit counts only rivals its earlier
   revision did not already have.
5. `describeRoadCuts` over the new membership reports the cuts that involve the incoming design.

## Not covered yet

- Existing city buildings a road or building would demolish, and the tunnel choice, need the
  building stock; `ugt_compare` reports counts today.
- Cadastral ground effects (agreement inputs and outputs) stay with `ugt_draft_agreement`.

## Remaining work

- Demolition and tunnel consequences from the building stock (see Not covered yet).
- Placement lives in `backend/agents/mcp-plan-placement.js`; the authoring tools reach it through
  `placeDesigns` in `mcp-named-plans.js`, wrapped in `ugt-agent-tools.js`.
