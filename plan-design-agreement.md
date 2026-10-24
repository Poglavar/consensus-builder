<!-- Design of record for the plan / design / agreement rework: what a design, an agreement and a plan are, what replaces named plans and decision kinds, and the open questions still being settled. -->

# Plan, design, agreement

**Current addition (2026-10-24): named map snapshots.** “Name this plan” in Designs → Share
saves a `plan/v1` record containing the title, selected published design CIDs and map view.
Its `/plans/<cid>` link opens those exact designs through the ordinary shared-design flow.
Renaming or changing the selection or view creates a different snapshot; old links retain their
content. Agreements still own land allocations, money and decision rules. This is a small new
record, independent of the former named-plan machinery removed in M2. The milestone descriptions
below remain the historical implementation record. See [named-plan validation and release notes](docs/named-plans-validation.md).

**Status (2026-10-22): M1, M2 and M3 built and tested; M3 committed, nothing pushed or deployed.**
"Lay out parcels" (M1 a) and the local agreement with its dialog, panel and list (M1 b) came first.
M2 (the "M2 build contract" below) publishes designs and agreements as CIDv1 UnixFS files with raw leaves, pinned
through `POST /pins` and indexed in `consensus.design` / `consensus.agreement`; share links are
`/designs/<cid,…>` and `/agreements/<cid>`; design dialogs have no terms or kind; the decide-later
type, Walrus, prepare, the proposal write path, edit tokens, effect hashes, lineage by row id and
named plans are gone. M3 (the "M3 notes" below) puts the agreement on chain: the Solana `agreement`
program (create, fund, attest, execute, cancel, expire; the lens attests `AgreementDecision`
`satisfied` only; non-binding agreements are never minted and have no markets), the agreement panel's
Mint / Propose again / Fund / Record decision / Execute / Cancel / Expire and the Minted agreements
list, `POST /agreements/:cid/onchain` and `GET /agreements?minted=1`, markets, bets and pledges on
agreement accounts (`agreement-execution-v1`; LMSR cancelled settles void, parimutuel NO), the
lifecycle oracle writing `agreement_lifecycle` / `agreement_executed` land events and the observed
status and end time onto the index row, agents proposing binding owners' agreements as devnet owners
of their parcels (stages planned → chosen → designed → proposed → minted → recorded → staked, then
settlement; 26 MCP tools), the restatement scripts on designs and agreements, the agreement editor as
a right-docked map panel with pick-on-map, and the removal of per-design owner acceptances, chain
refs, named-plan and minted-proposal readers, Canton and the EVM proposal readers. The M3 test pass
(all tests at the end, then three fix rounds): full headless unit suite 876 of 879 files (14,181
tests; parcel-deep-link-city, qualified-city-release and cotonou-live-source fail on the base branch
too), `anchor test` 223 passing, full headless Playwright 637 of 645 (3 load flakes pass alone, 4
specs adapted to the M3 activity vocabulary, "Use my location" fails on the base branch), full headed
Playwright 621 of 645 (26 of the 28 rerun pass alone; dynamic-factory-controls passes with one
worker; schelling-plan.spec.ts:87 fails headed on the base branch too), control contract 862 sites,
feature inventory 109 commands. Needs the user: deploy the `agreement` program (the id is still the
placeholder, so nothing can mint), seed devnet owners (`scripts/seed-lens-owners.mjs`),
`AGENT_LIFECYCLE_LENS_OPERATOR_TOKEN` for live runs, `scripts/drop-proposal-era.mjs --apply`
after a backup (dry run only so far), and the demo content recreated through the restatement scripts.
Leftovers to flatten when touched: `readjustment-contributions.js` is loaded but unused;
`subdivision.js planCreateVerdict` and `formation-edit.js clipPiecesByTaking` are used only by
tests; the how-to guides still describe the old editor; an output piece anchored to a parcel outside
the inputs counts with its whole area in the ledger; unowned output land is in no ledger row; the
rights preview names local parties by agent id; hand-placed structure `decorations` are not part of
the published design object; a parcel panel opened while the agreement panel is up sits under it on
the dock; the transaction decoder gives agreement instructions only the generic summary; the actor
explorer's own labels are English in code; the zagreb-isochrone walk and drive sims must read
`GET /designs/:cid`; the alerts-server-telegram "UGT Land Event Oracle" check expects the old oracle
entrypoint; the production `.env` still carries unused Canton variables.

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

## M1 (b) build contract: the agreement as a browser record (2026-10-21)

Local only: no server, no chain, no change to how designs publish. The agreement is a record in the
browser's city database; the dialog creates and edits it over applied designs. This section is the
contract the build follows; it changes only by a recorded decision.

### Record

`agreement`, stored as JSON at the key `agreement:<id>` in the city's IndexedDB `kv` store, next to
the `proposal:<id>` rows. It never takes part in `ParcelMutation`: an agreement changes no fabric.

```
{
  schema: 'agreement/v1',
  id: 'ag-…',                      // local key, stable across edits (not a content hash)
  title: string | null,
  city: string | null,
  createdAt, updatedAt: ISO,
  designs: [{ proposalId, title, goal, fingerprint }],     // authored order; fingerprint = the
                                                           // design's content fingerprint (c2-…)
  inputs: {                                                // the land the designs take, on the ground
    parcels: [{ parcelId, areaM2: number | null,           // they were applied to: base cadastral ids
                holders: [{ ownerKey, displayName, share }] }],   // holders from the local owner
    openGroundM2: number                                   // records; [] = unowned
  },
  outputs: [{ hash, pieceId, areaM2, fromParcelIds: [], producedBy: proposalId | null,
              role: 'plot' | 'remainder' | 'corridor' | 'part' | 'parcel',
              holders: [{ ownerKey, displayName, share }], geometry }],
                                                           // every piece standing on the input land
                                                           // after the designs are applied; hash =
                                                           // 'piece1-sha256:' + sha256 of the canonical
                                                           // geometry (coordinates rounded to 7 decimals)
  allocations: [{ output: hash, to: { kind: 'holders' } | { kind: 'party', ownerKey }
                                     | { kind: 'public' } | { kind: 'joint', shares: [{ ownerKey, share }] } }],
                                                           // an output without a line is 'holders'
                                                           // (the carried-over holding)
  money: { currency: 'EUR', lines: [{ ownerKey, amountCents }] },   // + receives, − pays; the
                                                           // sponsor line is computed, never stored
  rule: { electorate: 'owners' | 'community', binding: boolean,
          approvalConfig: { schema: 'proposal-approval/v1', rights, policy, regime? } | null,
          lens: [] },                                      // community: non-binding, no config
  deadline: ISO | null
}
```

- **Inputs are derived, never typed.** For each design: its declared `cadastreParcelIds` plus the
  cadastral ids of the pieces the fabric says it produced. Area comes from the original cadastral
  feature; holders from the local owner records (`parcel_<id>_owner`; a joint-pool agent expands to
  its members). Open ground is the sum of the layouts' `openGroundM2`.
- **Outputs are read from the fabric**: `LiveParcelFabric.entriesForCadastre(inputIds, { includeCorridors: true })`,
  so plots, remainders, corridor bodies, split parts and untouched parcels all appear; holders are
  what the fabric carries. Outputs are sorted by `fromParcelIds`, then area descending, then hash.
- **Decision rule** = the existing approval engine, unchanged: `rule.approvalConfig` is a
  `proposal-approval/v1` config (rights, policy, regime) and the engine's `inspect`/`tally` take
  `{ cadastreParcelIds: input ids, approvalConfig, lens }`. The three decision kinds become
  `electorate` + `binding`: owner deal = owners, binding; owner vote = owners, non-binding; community
  vote = community, non-binding (no config). The default rights snapshot is built from the inputs'
  local holders (`parcel-rights/v1`, provider `local-owners`, shares in basis points, the last
  holder taking the remainder); importing a rights file replaces it.
- **Ledger** (reuse): per party, contributed m² (inputs × share), assigned m² (outputs × share by
  allocation), the change, and cash; the money schedule and its balance come from
  `ReparcellizationDeal.schedule`; joint shares parse with `ReparcellizationAllocation.parsePercentShares`.
- **Current or stale**: the panel re-derives inputs and outputs from the fabric and compares them
  with the record (`AgreementGround.check`): a missing, unapplied or changed design, or different
  input ids or output hashes, mark the agreement stale and disable Compare. Nothing is auto-updated;
  Edit recomputes.
- Flattened (not carried over): deposit, decay, conditional and disbursement terms (chain funding
  mechanics, revisited in M3); per-input child agreements; the LR deal payload and its fingerprint
  (the agreement's CID replaces it in M2); `reparcellizationAgreement` on records.

### Modules

- `frontend/js/agreement-record.js` — pure, UMD, `window.AgreementRecord`: `SCHEMA`, `newId()`,
  `outputHash(geometry)`, `normalize(raw)` (throws `code: 'invalid-agreement'`),
  `validate(agreement, { designOf?, isApplied? })` → `{ valid, errors: [{ code, message, section }], warnings }`
  with sections `designs | land | allocation | money | rule | details` and codes `no-designs`,
  `design-not-applied`, `no-inputs`, `allocation-unknown-output`, `allocation-unknown-party`,
  `allocation-shares-invalid`, `money-currency`, `money-party-unknown`, `money-amount-invalid`,
  `rule-invalid`, `rule-community-binding`, `deadline-invalid`; warnings `rule-not-ready` (the
  engine's `inspect` reason) and `open-ground`; `ledger(agreement)` → `{ parties: [{ ownerKey,
  displayName, contributedM2, assignedM2, changeM2, cashCents }], publicM2, money }`;
  `rightsFromInputs(inputs)`; `approvalSubject(agreement)`; `stableStringify`.
- `frontend/js/agreement-ground.js` — pure, UMD, `window.AgreementGround`:
  `derive({ designs, fabric, originals, ownerOf, area })` → `{ inputs, outputs }`;
  `check(agreement, { designOf, isApplied, fingerprintOf, fabric, originals, ownerOf, area })` →
  `{ current, reasons: [{ code: 'design-missing' | 'design-not-applied' | 'design-changed' | 'ground-changed', proposalId? }] }`;
  `localHolders({ storage, agents })` → the `ownerOf(parcelId)` lookup over the local owner records.
- `frontend/js/agreement-store.js` — `window.AgreementStore`: `list()`, `get(id)`, `save(agreement)`,
  `remove(id)`, `clear()`, `subscribe(fn)`; writes refuse in a secondary tab (`code: 'secondary-tab'`);
  `clearLocalProposalData` also clears agreements.
- `frontend/js/agreement-dialog.js` — `window.AgreementDialog.open({ agreementId?, designIds? })` on
  `CbDialog`, one scrolling body with sections `[data-agreement-section=designs|land|allocation|money|rule|details]`:
  a checklist of the applied local designs (`[data-agreement-design=<id>]`), the derived inputs and
  outputs (`[data-agreement-inputs]`, `[data-agreement-outputs]`) with one allocation select per
  output (`[data-agreement-allocation=<hash>]`: current holders, each input party, public), cash per
  party (`[data-agreement-cash=<ownerKey>]`, EUR) with the computed sponsor line, the rule
  (`[name=agreement-electorate]`, `[data-agreement-binding]`, and for owners the approval form
  `ProposalApprovalSetup.html(...)` inside `[data-agreement-rule-form]`, with its import, template,
  remove and custom-test actions), a title and a deadline; errors in `[data-agreement-errors]`;
  Save validates, stores and opens the panel; Cancel discards.
- `frontend/js/agreement-panel.js` — `window.AgreementPanel.open(id)`, `close()`: the docked
  `section#agreement-panel.info-panel.right-dock-panel.agreement-panel` (the plan view's pattern):
  status badge (current or stale with reasons), designs (`[data-agreement-design=<id>]` selects the
  design on the map), land, allocations, ledger, rule summary, actions
  `[data-agreement-action=compare|edit|delete|close]`. Compare runs the before/after over the
  agreement's input parcels (`toggleAgreementBeforeAfter(id)` in `before-after.js`).
- `frontend/js/agreement-list.js` — `window.AgreementList.open()`: a dialog listing the local
  agreements (`.agreement-item[data-agreement-id]`) with "Create agreement" (`[data-agreement-action=create]`).
- Entry points: the sidebar button `#agreementsButton` ("Agreements", command `proposals.agreements`)
  and the details panel's "Create agreement" (`.btn-create-agreement`, shown for an applied design;
  for a layout it is the main action next to the disabled Share).
- CSS: `frontend/css/agreement-dialog.css` (the dialog) and `frontend/css/agreement.css` (panel, list, sidebar button) on the tokens; i18n namespace `agreement.*`
  plus `sidebar.proposals.agreementsButton` and `panel.proposal.actions.createAgreement`, in en, es,
  hr and sr.
- Tests: headless unit tests `backend/test/agreement-record.test.js`, `agreement-ground.test.js`,
  `agreement-store.test.js`; Playwright `e2e/tests/agreement-dialog.spec.ts` (apply a layout, create
  an agreement from its details, see inputs and outputs, pick a rule, save, reopen from the list,
  compare, edit, delete). `e2e/control-contract.json` and `feature-inventory.json` gain the new controls.

## M2 build contract: publish (2026-10-21, drafted after M1; the three flagged calls await the user)

Designs and agreements leave the device as content-addressed objects; the server is an index and a
courier, never the identity. Everything below follows the decisions above; the places where a call
had to be made are marked **(call)**.

### Identity: one CID scheme

- A published object's identity is its **CIDv1 UnixFS file address, multihash sha2-256, base32
  lower-case**, over the object's canonical bytes: `stableStringify` (keys sorted at
  every depth, no whitespace) encoded as UTF-8. Computed in the browser by a pure module
  `frontend/js/cid.js` on the vendored noble sha256; the server recomputes it from the bytes it
  receives and refuses a mismatch. The file profile uses fixed 256 KiB chunks and raw leaves:
  one chunk has codec `raw` (0x55, `bafkrei…`); multiple chunks have a UnixFS `dag-pb` root
  (0x70, `bafybei…`). The publication budget is 10 MiB, independently of chunk size.
  Identical sole-building and whole-block features are stored once under `geometry.buildings`;
  affected older duplicate records require review and republication under this canonical contract.
  Pinata files use `cidVersion: 1`; the courier compares its answer with the computed CID and refuses
  on a difference, so a wrong assumption fails loudly at the first pin, never silently.
- **Design object** `design/v1`: `{ schema, goal, title, description, author, city, site, toleranceM,
  roadProposal | buildingProposal | structureProposal | parcelLayout (cleaned
  as `proposalContentPayload` cleans them today), geometry, origin: { cid } | null, authoredAt }`.
  Nothing else: no cadastre ids, terms, kind, approval, lens, lifecycle, server ids, thumbnails.
  A local design's CID replaces `proposalContentFingerprint` (`c2-…`), `effectHash`, the consent
  fingerprint and the LR design fingerprint; `designs[].fingerprint` of a local agreement becomes
  `designs[].cid`.
- **Agreement object** `agreement/v1` (published form of the M1 (b) record): `designs: [{ cid, goal,
  title }]` in authored order; `inputs` (parcel ids with `parcelSourceId`, areas, the holders
  snapshot) and `openGroundM2`; `outputs: [{ hash, areaM2, fromParcelIds, role, producedBy: cid | null }]`
  without geometry (the hash commits to it; a reader re-derives the pieces by applying the designs
  and checks the hashes); `allocations`, `money`, `rule` (with the rights snapshot and lens keys),
  `deadline`, `title`, `author`, `sponsor` (the base58 wallet that will mint and fund it, null when
  proposed without one; M3 derives the on-chain address from it), `city`, `createdAt`. Its CID
  commits to the design CIDs and so to everything transitively; a counter-agreement reuses the
  design objects.
- Drafts stay local records with local ids; publishing computes the CIDs, pins the designs that have
  none, then the agreement.

### Courier and index (server)

- `POST /pins` `{ kind: 'design' | 'agreement', cid, bytes (base64) }`: recompute the CID, pin the
  exact bytes through Pinata with `cidVersion: 1`, compare, answer `{ cid, pinnedAt }` or 409
  `cid-mismatch`. 1 MB per object. Walrus is removed entirely (storage module, route, scripts,
  frontend provider switch, CSP entry, tests).
- Tables, one definition each under `backend/db/`: `design` (`cid` PK, `city`, `goal`, `title`,
  `author`, `site` geometry, `bounds`, `binding` JSONB = the parcels the server finds under the site,
  `content` JSONB, `origin_cid`, `created_at`, thumbnail URLs) and `agreement` (`cid` PK, `city`,
  `title`, `author`, `design_cids TEXT[]`, `input_parcel_ids TEXT[]`, `parcel_source_id`, `deadline`,
  `content` JSONB, `created_at`, thumbnail URLs, `onchain` JSONB for M3). Decisions move to
  `agreement_decision` keyed by agreement CID. **(call)** M2 removes every write path into the
  `proposal` table (the create and mirror routes, prepare, binding-drift, effect-hash stamping, edit
  tokens, the serializer's publish side) and the named plans entirely (`ens_plan`, `/plans`, plan
  hash, plan view, Create named plan, plan thumbnails, backfills); content consumers are re-pointed
  in M2 (thumbnails, JSON-LD, the OG worker, ENS numeric labels, the proposal list's server source).
  The chain readers (markets, bets, oracle, agents, lifecycle) still read `proposal` until M3
  re-points them at `agreement`; the table itself is dropped as M3's last server step, so the
  backend keeps booting in between and no parallel write path exists at any time. Prod demo
  content is recreated after M3.
- `POST /designs` `{ cid, content }`: verify the CID and the schema, derive the city from the site,
  derive the binding (which parcels the site takes, as `checkProposalBinding` derives it today, no
  declaration to compare), insert, queue the thumbnail. `GET /designs/:cid`, `GET /designs?city|bbox`,
  `POST /designs/batch`. A parcel layout is indexed only as part of an agreement publish.
- `POST /agreements` `{ cid, content }`: verify the CID, every design CID indexed, the inputs equal
  the union of the designs' server bindings (the former "declaration equals binding" check, now
  agreement-level), the rights snapshot well-formed, the deadline in the future; insert; thumbnail.
  `GET /agreements/:cid`, `?design=<cid>`, `?parcel=<id>`, `?city`. Expired is computed from the
  deadline; Executed and Cancelled come from the chain in M3.
- Owner decisions: the signed statement becomes `{ schema: 'agreement-decision/v1', agreementCid,
  ownerId, actorId, contextHash, decision, decidedAt }`; relay at `/agreements/:cid/decisions`
  (admit, fold, list) with the same receipt verification as today; the lens approval endpoints take
  the agreement CID as the subject. The engine (`ProposalApproval.tally`) counts over admitted
  receipts in the browser and on the server for the index's `decision` summary.

### Browser

- Publishing a design: "Share" on an applied design pins and indexes it and copies
  `/designs/<cid>`; several applied designs share as `/designs/<cid>,<cid>`. The upload modal, the
  terms dialog, the "Who decides" row, "Create named plan", `?shared=` payload links and the
  `/proposals/<ids>` route go; the reader of `/designs/<cids>` imports from the index (from IPFS in M3).
- Publishing an agreement: "Propose" on the agreement panel (the verb for putting an agreement to
  its parties): pin designs, pin the agreement, index, copy `/agreements/<cid>`. The panel then
  shows the decision tally and the owner Accept / Withdraw actions (today's owner-acceptance card,
  moved from the design details to the agreement and signing the agreement CID). Design details
  lose their consent card, lifecycle badges, expiry and funding rows.
- Design dialogs lose every term and kind control (`dialog-create.js` options rows, the editor's
  Terms and Approval tabs, `publish-terms.js` down to `publishRefusal`, `proposal-kind.js` deleted);
  the record loses the term fields; "Fork proposal" becomes "Fork design" and records `origin.cid`.
- Vocabulary: `proposal*` modules and routes touched by this milestone are renamed to `design*`
  as they are rewritten; untouched ones keep their names and the mapping table.
- Order of work (user rule, 2026-10-21, for M2 and M3): every code change of the milestone first,
  then all tests written in one pass at the end, then fixes. No test writing or test runs in between.
- Tests, in that final pass: pure tests for `cid.js` (known CID vectors), design and agreement
  canonical objects, the decision statement; route tests for pins, designs and agreements;
  Playwright for sharing a design and proposing an agreement against the mocked API; the control
  contract regenerated; the named-plan, prepare, terms, kind and Walrus tests deleted with their code.

## M3 notes (2026-10-21, program built, not deployed)

- The Solana `agreement` program (`blockchain/solana/programs/agreement`) has `create(cid, lens,
  deadline, open_ground, required_lamports, payout)`, `fund`, `attest`, `execute`, `cancel`,
  `expire`; one account per agreement holding the escrow; the lens attests `AgreementDecision`
  (`string agreementCid, string sponsor, string decision, string evidenceRef, int64 sourceObservedAt`;
  the sponsor must equal the account's authority, so an attestation fits one account only), one
  final decision per agreement; `execute` is permissionless and releases the escrow to `payout`.
- **Decision:** the account address is `["agreement", sponsor, sha256(cid)]`, so a published CID
  cannot be squatted by a stranger creating its account first; the agreement object carries the
  sponsor wallet, and the index's `onchain` column records the account once minted.
- **Decision:** funding is enforced on every agreement; `required_lamports: 0` means none, and
  `open_ground` is recorded for readers only.
- **UI decision (user, 2026-10-22):** the Create/Edit agreement dialog becomes a narrower panel
  docked on the right of the map on desktop (a bottom sheet on phones), replacing the agreement
  details panel while it is open, so the designs in the agreement are highlighted on the map and
  clicking an applied design on the map adds or removes it. From a design's details, "Add to
  agreement" offers a new agreement or one of the existing unpublished ones. One pick-on-map
  mechanism (`map-pick.js`) serves the share panel and the editor.
- **Decision (2026-10-22):** the lens never refuses. It attests `satisfied` when the engine's tally
  passes; after the deadline an unsatisfied agreement can only expire, which says everything a
  refusal would, and the program's `attest` is closed after the deadline anyway. `decision` is
  `pending` or `satisfied`.
- **Decision (2026-10-22):** the market and pledge programs read the `agreement` program's account
  as their subject (owner, discriminator, status byte at offset 136: 0 Active, 1 Executed,
  2 Cancelled, 3 Expired) and no longer read `proposal_nft`; markets settle YES on Executed, NO on
  Cancelled or Expired. The programs keep their names and ids until a deploy assigns new ones.
- **Decisions (2026-10-22, consolidation):** LMSR markets keep settling a cancelled agreement as
  void and parimutuel pools as NO (the 2026-10-12 rule); donations and pledges pay out to the
  sponsor (the agreement's authority); the in-app Canton mode, the standalone Canton console and
  the backend `/canton` routes are deleted (a third chain returns, if at all, on agreements); the
  EVM proposal-NFT readers are deleted, the EVM wallet connection stays, and EVM support returns
  later on agreements; the agreement editor is a right-docked map panel with pick-on-map
  (`map-pick.js`, shared with the share panel) and "Add to agreement" on a design's details.
- **Decision (2026-10-22):** a non-binding agreement (community vote, owner vote) is never minted
  and has no market; it is a poll in the index whose decisions are counted off-chain. Minting,
  escrow, attestation, execution and markets are for binding owners' agreements only. The
  autonomous proposers therefore propose binding owners' agreements over parcels whose devnet
  owner is the bot's own wallet (seeded in the lens owner registry), sign their approval, have
  their lens attest, and execute.
- Pending for M3: the lens issues the attestation (`backend/oracle/lens-schemas.js`), the browser
  mint and fund flow on the agreement panel, markets, oracle, parcel history and agents on
  agreements, the `proposal` table drop, prod demo content recreated. EVM later.
