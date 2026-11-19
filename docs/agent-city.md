<!-- Contract: the Agent city view, simulation ghosts, simulated owners' agreements and the local agents' building designs. -->
# Agent city

The Agent city shows the designs agents' agreements executed, drawn on the map as they stood on a
chosen day. It has two sources: the published agents (the index's executed agreements in the current
city) and this browser's simulation. Nothing in it is applied, imported or published.

## Decisions

- **Draw, never apply.** Simulation ghosts and the Agent city draw designs in their own look and
  leave the parcel fabric, the saved designs and the applied state untouched. Closing the view or
  stopping the simulation leaves nothing behind.
- **A later execution replaces an earlier one on the same parcel.** At a given day the view shows,
  for each parcel, the latest executed design.
- **The two sources keep their own clocks.** Published agreements carry the chain's execution time;
  the simulation carries its simulated date (one week per turn). They are never mixed on one axis.
- **Simulated agreements are not records.** They are part of the saved game state, are cleared by
  New game, and are never minted, published or attested.

## Design display (`frontend/js/design-display.js`)

One draw-only renderer for designs that are not applied, used by both layers.

- `displayParts(design)` reads a local design record or published `design/v1` content and returns its
  parts: `building` (with a height from `height`, else floors at 3 m), `park`, `square`, `lake`, or
  `ground` (a road surface or plots).
- Layers: `ghosts` and `agentCity`. Each entry is `{ key, design, opacity, fresh, open }`. While the
  `agentCity` layer is set (the view is open), it is the only layer drawn.
- 2D: Leaflet paths with `.design-display--<kind>` classes, colours in `--cb-map-display-*` tokens
  (`frontend/css/tokens.css`). Opacity comes from three panes (`design-display-pane--1..3`), so a
  ghost fades as a whole. A fresh entry fades in, except with reduced motion.
- Model and photo 3D: `rebuildDesignDisplay3D` in `frontend/js/three-mode.js` draws buildings as
  applied buildings are drawn (`createBuildingSlices`, own hue and facade), parks and squares with
  their generated decorations, and lakes as flat water. It digs no basin and demolishes nothing.
- A click on a drawn design opens it: a published agreement in its panel, a design of this browser
  as a selected design (3D) or in its compact card (2D). A building standing in front takes the
  click instead.

## Simulation ghosts (`frontend/js/simulation-ghosts.js`)

The designs agents drew in a turn are ghosts at full strength, two thirds a turn later, one third
two turns later, and gone after three turns. Stop and New game clear them. An applied design has no
ghost.

## Simulated agreements (`frontend/js/simulation-agreements.js`)

- Each new agent design opens an agreement over its parcels. Its approvers are the parcels' owning
  agents; a parcel no agent owns is decided by the city. The proposer approves its own land at once,
  so a design wholly on it executes on its first turn.
- Every turn each undecided approver approves with probability 0.2 or refuses with 0.1. One refusal
  closes the agreement (`refused`); all approvals execute it (`executed`, on that turn's simulated
  date); ten turns without both close it (`expired`).
- An execution takes its parcels: other open agreements over any of them close as `superseded`.
- A user-controlled owner is never decided for; a design needing their approval waits out its
  deadline.
- Executions, refusals and lapses are simulation activity with the design's link.

## Local agents' building designs (`frontend/js/agent-building-design.js`)

Six in ten agent designs are a single building on one parcel, on the agent's own land half the time
it owns any. The massing is the server agents' method (`backend/agents/planner.js`): the parcel's
envelope under an urban rule and one seeded build-out inside it (`urban-rule-variation.js`). The
simulation knows no rule for the parcel, so the rule is the default setback with a storey ceiling
drawn from 2 to 8. The record is the `buildings` design with the single-building typology, as
`backend/agents/record-builder.js` builds it. The other designs stay parks, squares and lakes over
one to ten neighbouring parcels.

## Interface

The **Agent city card** (`#agent-city`, styled as the build-out time control) sits at the bottom
centre: title, close, a source switch (Published agents, This simulation), previous day, play/pause,
next day, the day shown, a slider over the execution days and a summary of designs standing and
executions so far. The simulation bar steps aside while it is open.

- Opened from the Activity sheet header (published agents) and the simulation bar (this simulation),
  or by `?agentcity=server|simulation` in the address once the app has booted.
- Published agents: `GET /agreements?city=` (paged), the `executed` rows, their first design by
  `POST /designs/batch`, the day from `onchain.executedAt`.
- This simulation follows new executions while it shows the newest day.
- Loading the published agents frames their designs once.

## MCP parity

No change: the view and the simulation edit nothing. Executed agreements and their designs are
already readable through the MCP agreement and design tools.

## Tests

`backend/test/frontend-agent-city.test.js` (display parts and layers, building designs, simulated
agreements, the timeline), `backend/test/frontend-simulation-ghosts.test.js`,
`e2e/tests/agent-city.spec.ts` (the card over mocked executed agreements).
