<!-- Design of record for the plan / design / agreement rework: what a design, an agreement and a plan are, what replaces named plans and decision kinds, and the open questions still being settled. -->

# Plan, design, agreement

A rework of what sits above a single authored change. Started 2026-10-21 on branch
`plan-design-agreement` (off `colosseum-worlds-fair` at 3a62b4a7e, which includes the Schelling plan
layer). Design discussion only so far; nothing below is implemented. This is the living plan:
decisions are appended as they are made and the open list shrinks.

## Decisions (user, 2026-10-21)

### Two records and one informal word

| Term | What it is | Record? |
|---|---|---|
| **Design** | One authored change: a road, a park, a parcel layout, an urban rule, a building. Today's "proposal". Immutable once published; referenced by agreements, never owned by one. Carries its design type (road, lake, …) and nothing about who decides. | yes |
| **Agreement** | A set of designs plus a **decision rule** (who decides, how they are counted, whether it binds), with allocations and money optional. A vote is an agreement with no allocation; an authority adopting a plan is an agreement whose rule is "this authority decides". The unit that is signed, minted, ENS-named, bet on and executed. | yes |
| **Plan** | No record. The informal word for what is on the map (the applied composition) and for a share link of selected designs. | no |

- A loose bundle of designs with no decision rule is never a record: nothing can happen to it
  inside the app, so there is nothing to sign and nothing for a market to settle on.
- Markets, ENS names and mints attach to agreements only. A design on its own is shareable; nobody
  decides on it and it is not bettable until an agreement includes it.
- **Decision rule** replaces the publish-time **decision kind** of `proposal-kinds.md`: owner deal,
  owner vote and community vote become rules an agreement can have. Decision 7 there (every
  published record carries a kind) is reversed: a bare design carries none. "Kind" is left to mean
  the design type.
- Several agreements may cover the same designs at once. A counterproposal that changes only the
  terms is a **counter-agreement** over the same design records; one that changes geometry is a
  fork of the design. A design's hash is therefore pure geometry, site and rules; terms never move it.
- Exclusivity is enforced only at execution, on the input land: two open agreements over the same
  land are both allowed and form one market contest; only one can execute.

### Consent and execution move to the agreement (pitfall 2, user 2026-10-21)

- Only agreements have a lifecycle (Active, Executed, Cancelled, Expired, a deadline). Designs are
  content: draft, published, forked. No design-level consent, status or expiry.
- Execution is one event: every allocation moves at once, obligations settle from one escrow per
  agreement, parcel history gets one entry per affected parcel pointing at the agreement. Map
  application stays a local preview. Funding is per agreement.
- **What is minted:** the agreement, as one chain account committing to the agreement's content on
  **IPFS**, never a server URL and not Walrus (deprecated, possibly dead). Reading stays independent
  of our server, as `chain-proposal-loader.js` already is.
- **Who counts:** the approval engine counts off-chain from published signed decisions, anyone can
  re-run it, and the agreement's named lens attests "decision satisfied" on chain; the program
  checks that attestation plus escrow (option b). Chain order stays Solana first, EVM later.
- **Terms are a separate step for every design.** Drawing and publishing a design never asks for
  terms; "Create agreement" is its own dialog over chosen designs, usable immediately after drawing.
  Nothing is auto-coupled, not even a single road with cash.

- **Content addressing (confirmed):** a design is its own IPFS object and its content hash is its
  CID; an agreement is an object of links to design CIDs plus inputs, decision rule, allocations and
  money, so its CID commits to everything transitively and a counter-agreement reuses the design
  objects. This one scheme replaces the effect hash, the plan hash and the member hashes.
- **Pinning (confirmed):** the browser computes the CIDs, the backend relay pins them as a courier
  only, the browser verifies the pinned CID before minting. `POST /proposals/prepare` goes away,
  which settles the pending "mint must not need the server" decision.
- **No unanimity carve-out (confirmed):** every decision rule executes on the lens attestation,
  because the owner set is lens-backed anyway.
- **Draft agreements (confirmed):** an agreement may be drafted over local unpublished designs;
  publishing or minting it pins them first.

### Drawing is only drawing; allocation is separate (pitfall 4, user 2026-10-21)

- The Approval tab's "Agreement rules" (voluntary all-owners, the research templates, custom) is
  the agreement's **decision rule**; the approval engine behind it moves to the agreement unchanged.
- An agreement always settles the whole input land of its designs (option A). Gradual
  participation is done with separate designs, each confined to the land its own agreement
  settles; a shared courtyard is one agreement, all or nothing. The per-input "separate
  agreements" mode of `reparcellization-agreements.js` (child proposals with their own site and
  anchor, largest-remainder cash per child) is dropped.
- The **parcel-layout design keeps only geometry**: the pool outline and the output plots.
  Recipient, public or joint role, valuation and cash are allocation lines of the agreement.
  "Assign this plot to public" is no longer a drawing act.
- Standing rule (user): anything that exists now but is more complicated than the new design
  needs is flagged and flattened, not carried over. Candidates are listed under "Simplifications".

### Carried over from the Codex design session of 2026-10-21 (notes commits 0a5d0c9b0, ac30810b3)

- Roads are roads, drawn with the road tool, never inside the parcel-layout editor (user,
  2026-10-21: "roads are roads"). The one new drawing tool is the **parcel layout**, which only
  redraws parcel borders. Roads, parks, rules and layouts are combined only in the agreement,
  which pools the land across all of them, so drawing steps never decide who bears the cost of a street.
- Designs never depend on other designs, only on the ground being available.
- No temporal component: an agreement settles ownership, allocations, money and rules. What gets
  built when is out of scope.
- Urban rules stay spatially exclusive with one another; an urban rule may coexist with a parcel
  layout on the same ground (vocabulary.md, "Accepted direction: urban-rule overlap").
- The painted Schelling superblock is a natural agreement scope: one road-network design, one
  parcel-layout design per block, one agreement whose pool is every parcel the blocks touch.

### What this replaces

- Named plans as records (`plans.md`). Their machinery (member hashes, aggregate hash, site-only
  mint, ENS name, one market) is re-pointed at agreements, with the terms moved from the members
  onto the bundle. "Which plan gets built" becomes "which agreement executes".
- Decision kinds (`proposal-kinds.md`): moved onto the agreement as its decision rule.
- The land-readjustment record that bundles layout, allocations, cash and approval in one proposal
  (`land-readjustmend.md`): split into a parcel-layout design and an agreement. The approval engine
  of its §23 becomes the agreement's decision-rule engine.
- The Codex session's three-object model (plan, design or change, agreement): the loose plan is dropped.

No legacy support anywhere (user, 2026-10-21: the software is not in use yet). No compatibility
readers, no migrations, no parallel old/new paths; chain programs, contracts, hashes and prod
demo content may all change, and affected records are recreated.

## Open, in the order they are being worked through

1. Plan vs agreement. **Decided above.**
2. Consent and execution per design. **Decided above.**
3. Decision kinds. **Resolved with 1**: the decision rule lives on the agreement.
4. The two existing "agreement" meanings. **Decided above.**
5. Pooled before/after. **Closed by simplification 1**: inputs versus outputs of the agreement.
6. Replay order and content-hash ids. **Closed by simplification 1**: outputs are computed by
   applying the designs in authored order; changed ground changes the hashes and refuses the agreement.
7. Estimates. **Closed by simplification 1**: designs may be drawn over estimates; an estimate is
   never an agreement input, so that flow is exploration or open ground.
8. Naming. **Decided**: the object is a **design** ("spatial design" in the glossary); every button
   names the type (Draw road, Lay out parcels, Set urban rule); the umbrella appears only in
   collection headings, generic actions and code; "propose" is the verb for putting an agreement to
   its parties; "contract" and "deal" stay out of the UI. New code and tables use `design` and
   `agreement`; existing `proposal*` modules, routes and tables are renamed as the rework touches
   them, never in a bulk sweep, with vocabulary.md mapping the two until done. (The second opinion
   Codex requested came back "agree with changes" along the same lines.)
9. Sequencing. **Decided** (user, 2026-10-21, "proceed"):
   - **M1, local only, no server or chain change.** (a) The parcel-layout design: the LR geometry
     editor becomes "Lay out parcels", geometry only, with Schelling plots as an automatic layout;
     the user tests this first. (b) The agreement as a browser record: chosen designs, inputs
     derived by applying them to the current ground, outputs by content hash, decision rule from
     the existing regimes, allocations and money from the existing LR ledger, before/after from the
     dividers; a "Create agreement" dialog over applied designs. Existing design dialogs keep their
     term fields until M2 reworks publishing, so nothing is left half-published.
   - **M2, publish.** CIDs computed in the browser, pinned through the relay and verified; the
     server mirrors designs and agreements as an index; owner decisions signed over the agreement
     CID; the engine counts; the lens attests. Named plans and `prepare` removed; share links are
     design CIDs; design dialogs lose their terms and kind.
   - **M3, chain and markets.** The Solana agreement program; mint agreements; markets, oracle and
     parcel history on agreements; prod demo content recreated. EVM later.
   - Schelling: plots land in M1 (a); Move network and the free grid stay on `schelling-plan`.

## Simplifications the new design allows (candidates, flagged 2026-10-21)

1. **Designs carry no cadastre references.** A design is geometry on a site; which parcels it
   touches is derived by applying it to whatever ground is there ("proposals are geometry, parcels
   are derived", 2026-10-17). Only the agreement names parcels: its **inputs** (cadastral ids plus
   a rights snapshot, or open-ground entries) and its **outputs** (the pieces left after its designs
   are applied, by content hash). The publish-time rule "declared parcels must equal the server's
   binding" becomes an agreement-level check by the lens. This closes three open items by
   construction: pooled before/after is inputs versus outputs (5); replay order and content-hash ids
   are how outputs are computed, and changed ground changes the hashes and refuses the agreement
   (6); estimated parcels can be drawn over freely but can never be an agreement input, so they
   are exploration or open ground (7). **Confirmed by the user, 2026-10-21.**
2. One CID scheme replaces the effect hash, the plan hash and the member hashes (decided).
3. The named-plan record and its routes, hash, supersession, mint script, thumbnail backfill, plan
   view and "Part of plan" rows become the agreement's; one container type instead of two.
4. The proposal row loses every term column: `offer`, `offerCurrency`, `budget`, `decay*`,
   `deposit*`, `isConditional`, `disbursementMode`, `expiresAt`, approval configuration, decision
   kind and the sale-offer predicate. A sale is an agreement with no design at all.
5. Transaction goals (`ownership-transfer-from-me`) leave the goal taxonomy; a goal is a design
   type only, and `structureProposal.kind` can fold into it.
6. Per-design consent and lifecycle machinery goes: owner acceptances and tallies, signed owner
   decisions per proposal, effect-hash stamping, the lifecycle oracle keyed on proposal accounts,
   `verdict_may_execute` on proposals, parcel-history events per proposal. One set of these exists,
   keyed on the agreement.
7. The chain programs shrink to one agreement program: create (CID, lens, deadline), fund, attest,
   execute, cancel or expire. No per-parcel consent, owner lists, EAS self-claims, withdrawal or
   vote variants on chain; owner decisions are published documents the engine counts.
8. Lineage flattens: a design fork is a new CID with an optional link to the CID it came from; a
   terms counterproposal is a counter-agreement. The typed `proposalOrigin` and the lineage route
   can go.
9. The road and corridor import no longer declares parcels when a design is created (the
   `loadGroundUnder` step); the agreement derives them when it is created.
10. Market contests group agreements by shared input land; no folding of proposals under plans.

## M1 (a) build contract: the parcel-layout design (2026-10-21)

The land-readjustment editor becomes a geometry-only design editor. This section is the contract the
build follows; it changes only by a recorded decision.

- **Design type** `parcel-layout` (goal), record field `proposal.parcelLayout`, adapter key
  `parcel-layout`, `primaryType: 'ParcelLayout'`. UI name "Lay out parcels"; a site subdivision keeps
  the name "Subdivide" and produces the same design.
- **Record** `parcelLayout = { algorithm: 'equal' | 'schelling' | 'amend' | 'manual', generatedAt,
  pool: Polygon | MultiPolygon, poolSource?: 'site', openGroundM2?, totalArea, plotCount?,
  schelling?: { code }, inputParcels: [{ parcelId, cadastreParcelId?, geometry, label, area }] (amend
  only), plots: [{ geometry, area, source, derivation? }] }`. Plot `source` is one of `equal`,
  `schelling`, `schelling-remainder`, `amend`, `manual`, `base`, `geojson`, `form`. Nothing about
  owners, shares, roles, colours, cash, valuation, approval or agreement modes is stored.
- **Layouts offered:** Equal plots (a count, from 2; the sweep handle sets the direction), Schelling
  plots (the plan layer's current settings at the pool; plan plots clipped to the pool, and the pool
  ground they leave uncovered, the street strips, becomes plots too, so the layout always tiles the
  pool), Keep existing borders (the input parcels as plots), Draw freely. Plot drawing, line cuts,
  erase, node editing, undo/redo, GeoJSON upload, before/after compare, plot numbers, building
  footprints and courtyard carving (as a plot with a `derivation`, no joint shares) stay. Owner
  tables, cash, approval, assign owners, all public and shuffle go.
- **Editor module** `frontend/js/parcel-layout.js` (moved from `reparcellization.js`, history kept),
  factory `createParcelLayoutEditor`, browser entry `window.openParcelLayoutEditor(options)` with
  `{ algorithm?, initialPlots?, pool?, sitePool?, plotCount? }`; the seed and the result travel in
  `window.pendingParcelLayout` and `draft.editorPayload.plan`, as before under the old names. Pure
  helpers: `parcel-layout-validation.js` (`ParcelLayoutValidation.validate(plan, { turf, site? })`
  → `{ valid, errors, warnings }`, geometry rules only), `parcel-layout-layouts.js`
  (`ParcelLayoutLayouts.equalPlots`, `schellingPlots`), `parcel-layout-record.js`
  (`ParcelLayoutRecord.plotFingerprint(plot)`, `content(plan)`: geometry only),
  `parcel-layout-ownership.js` (`ParcelLayoutOwnership.ownersOf(plot, sources, ownerOf)`).
- **Apply** (`proposals/apply/parcels.js`, route `parcel-layout`): forms the plots as today, with the
  geometry-only fingerprint on `readjustmentPiece` (property name kept for now), and **carries
  ownership over instead of transferring it**: a plot inside one source parcel keeps that owner; a
  plot straddling several gets a joint holding with pro-rata shares by overlapping area; open ground
  stays unowned. A layout changes borders, never ownership; only an executed agreement does that.
- **Entry points:** the Build palette tile `parcel-layout` ("Lay out parcels") and the site tool's
  "Subdivide". The classic create dialog's Reparcellization type, "Readjust" facet, pending-plan
  hand-off and separate-agreements UI are removed, as are `reparcellization-agreements.js`, the LR
  approval forcing in publish-terms, the LR consent-hash special case and the LR "ownership and
  approval" action in details. The draft editor has no Ownership, Approval or Terms section for a
  layout.
- **Publishing a layout is refused in M1** with a message that layouts are shared with their
  agreement (M2); the server is untouched. Sharing and minting paths check this at their one choke
  point.
- **Tests:** the editor's characterization test and its fake-browser helper are rebuilt for the new
  editor; apply, audit and subdivision tests adapt to ownership carry-over; pure tests for the
  layouts, validation, record and ownership modules; Playwright specs for the editor (handles,
  undo/redo, erase, upload, compare, Schelling plots, plot references surviving apply and reload)
  replace the land-readjustment specs; specs of removed behaviour (cash consent, separate
  agreements, owner shares, LR approval) are deleted. `e2e/control-contract.json` is regenerated.
- **Kept for M1 (b):** `reparcellization-deal.js`, `-allocation.js`, `-ownership.js`, `-shares.js`,
  `-validation.js` and the approval engine stay, unused by the layout, for the agreement dialog.
