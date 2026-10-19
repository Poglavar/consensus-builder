<!-- Design of record for named plans: immutable named sets of proposals, and betting on them. -->

# Named plans

A **proposal** is an authored change, rule or transaction concerning land; it may contain several
buildings, streets or plots. A **named plan** is a named, ordered set of proposals: what people actually argue and bet
about ("the official UPU Borovje", "Borovje – urban blocks"). Decisions of 2026-10-10.

## Named membership and local application

An **applied composition** is the proposals currently applied in one browser and their materialized
effects. It can include proposals from several named plans, plus local drafts. It has no named-plan
identity of its own. Applying or removing a proposal changes this composition, not any named plan.

**Share applied proposals** lets the user choose a subset and upload its proposals. Copying the
resulting `/proposals/<row IDs>` link shares that selection without creating a named plan. The
separate **Create named plan** action creates the fixed membership record through `POST /plans`.
The browser's later application state does not update that record.

| Relationship | Meaning |
| --- | --- |
| Proposal is a member of a named plan | Durable, ordered membership recorded by the plan. |
| Proposal is applied in a browser | Local state that contributes to the current composition and derived fabric. |
| Proposal is selected for sharing | Temporary selection in the sharing panel; it can be a subset of the composition. |
| Proposal forms before another proposal | Replay chronology determined by authored/creation time and tie-breakers. |
| Proposal depends on another proposal | Prerequisite required by its authored inputs; membership or list position alone does not establish it. |

Member order contributes to the named-plan hash. It does not determine replay chronology or
declare dependencies. A statutory plan or a floor-plan drawing is a different kind of object;
this document uses “plan” as shorthand for **named plan** only.

**Applied proposal stats** reports the current browser composition. **Urban grain score** identifies
whether it is using that local composition or a named-plan scope. A named-plan card displays the
plan's title, or its slug when it has no title. Both named-score entry points fetch current plan
detail and require every member to be verified unchanged and applied with its exact published row
ID (`serverProposalId` locally). The author’s local key can differ from the published authored ID.
A local fork or replacement cannot stand in for that member; a fork counts only when its own
published row belongs to the plan. Missing, changed, unverified or unapplied members
prevent a named score, without falling back to the local composition.

The measurement still uses live fabric over the members' cadastral scope. Other applied proposals
may affect those parcels, so exact member selection does not yet guarantee an isolated or historically
reproducible result. Fabric isolation and explicit materialization inputs remain open as V19 in
[the audit register](vocabulary.md#audit-register--findings-and-resolutions).

## A named plan never changes

- `POST /plans` creates a plan. There is no update route: no `PUT`, no edit token.
- A revision is a new plan with a new name. The convention is `<name>-v2`, `-v3`, …; a taken
  name answers 409 with the next free `-vN` as `suggestion`.
- A revision records `supersedes: <old slug>`. The old plan is not touched; its page learns of
  the newer version by looking up who supersedes it (`supersededBy`, computed on read).
- There is no "latest" alias. A name that moves is exactly what this design removes.
- Title, description and author are fixed with the plan. A typo is a `-v2`.

## API identifiers

`POST /plans` names **published database rows**, for example:

```json
{ "slug": "harbor-plan", "proposalRowIds": ["41", "42"] }
```

- Creation and both list/detail responses use `proposalRowIds`, an ordered, deduplicated list of
  row-ID strings. Members do not have to be minted.
- `GET /plans?proposal_row_ids=41,42` finds plans containing any of those rows. The `city` and
  `parcel_ids` filters retain their existing meanings.
- `GET /plans/:slug` exposes each member's `proposalRowId` and `authoredProposalId` separately.
  A missing member retains `proposalRowId` and reports `missing: true`; its authored ID is unavailable.
- The retired creation field `proposalIds` and query filter `proposal_ids` return 400, including
  when supplied alongside the new fields. Responses have no old aliases.

The persisted column `ens_plan.proposal_ids` contains these row-ID strings. The plan hash uses
the members' **authored IDs** instead, so it is independent of database row numbering. See
[the maintained identifier definitions](vocabulary.md#proposal-identifiers-at-api-boundaries).

## A plan is only as fixed as its members

Published design changes create new proposals linked to their source. A plan retains the original
member rows; it does not need to duplicate their contents. At creation a plan stores:

- `member_hashes` — per member, SHA-256 of **decision kind, authored site and design/deal content**
  (`backend/plans/plan-hash.js`). Every member includes `proposal_data.kind` and
  `proposal_data.site`; an absent value is represented as `null`, without reading an alternative
  stored projection. Ordinary members also include goal, type, declared parcels, road definition,
  building/structure parameters and geometry, layout, and applicable approval context.
  Readjustment members include the canonical readjustment deal fingerprint, covering plots,
  allocations, financial terms and approval context. That deal fingerprint is a component of the
  plan member hash, not the whole hash. Descriptions, thumbnails and lifecycle state are excluded.
- `plan_hash` — sha256 over the ordered `[authoredProposalId, memberHash]` list
  (the hash helper calls that authored-ID input `proposalId`).
- `site` — the union of the members' sites, for the on-chain mint.

`GET /plans/:slug` requires one valid SHA-256 hash for every member and a valid plan hash before
comparing content. Missing, partial or malformed saved commitments return 422
(`plan-commitment-invalid`), including through the list route. There is no “unverified but unchanged”
case. For a valid saved commitment, a missing member or a content mismatch reports `changed: true`.

The database guards in [publication-immutability.sql](backend/db/publication-immutability.sql)
reject updates to published proposal content, including direct operator SQL and UPSERT overwrites.
The proposal's design, identity, terms, source references, site and binding remain fixed. Names,
descriptions, thumbnails, timeline labels, lifecycle/approval outcomes and chain attachment may
change; these are separate from authored design. The response ID mirrors in `proposal_data` may
be populated after insertion; the actual identifier columns remain fixed.

Named-plan fields are fixed too, including membership, hashes, title and supersession. Chain data
may be attached once. A repair must publish new proposal rows and name a new plan; the former
in-place repair/import scripts cannot overwrite existing content. The guards are applied by the
backend deployment's DDL step; no stored content is backfilled or restamped.

## Betting on a plan

One plan → one on-chain proposal account → one `proposal_market` pool. No program changes:

- `scripts/mint-plan.mjs` mints a site-only proposal account for the plan (site = the plan's
  site, `image_uri` = `ugt-plan:<slug>@<plan_hash>`, so the account commits to the exact
  content) and records it on the plan row (`onchain_data`). Before minting, the store verifies
  complete commitments, current member hashes and the aggregate plan hash; missing, changed or
  inconsistent content refuses the mint. ENS does not resolve plans with incomplete commitments.
- The pool is opened on that account like any other (Bets sheet "Open the pool", or the agents'
  `ensureMarketAndStake`). It settles like any proposal market: Executed → YES, Cancelled or
  Expired (lifecycle lens verdict) → NO.
- A single proposal stays bettable on its own; a plan of one is never required.

## Contests

`GET /markets` still groups by shared land. A named plan is an entry of its own (kind `plan`),
over the union of its members' parcels; proposals that belong to a plan in the contest fold under
it instead of appearing as separate rows (a member shared by two plans folds under both). The
contest takes its name from the plans' `place` (e.g. "Borovje") before any piece's `blockName`.
The Bets sheet heads such a contest "Which plan gets built?" and counts plans and loose proposals
apart.

## Hash portability

The plan hash is over members' stable `proposal_id`s and committed content, so the same plan named in
two databases hashes equal — one devnet mint can then be recorded in both
(`mint-plan.mjs --record-existing`, which checks the account's `image_uri` on chain first). The
PostGIS `site` projection and aggregate plan site are deliberately not hashed: PostGIS versions
can return the same union with different vertex order. The site in the authored JSON record is
hashed. Object keys are sorted; site coordinates retain their authored order and precision.
This commits to the recorded geometry, not topological equivalence of differently encoded polygons.

## Experimental contract changes

The 2026-10-19 contract includes decision kind and authored site for every member. There is one
current hashing path. Hashes produced by the preceding contract will report drift; recreate
affected experimental plans if needed. There is no old-hash verifier, backfill, or promise of
compatibility with prior plan mints. Stored commitments are never rewritten to appear verified.

The same day's API field rename makes row and authored identifiers explicit. All consumers must
use the names above; no alias reader is maintained. It changes no stored values or hash inputs.

V03 enforcement requires complete plan commitments on reads and new writes, and makes the
published-content/fork boundary a database invariant once its DDL is applied. Incomplete plans
must be discarded and recreated. This adds neither an older-contract reader nor stored snapshots.

## Links

- `/proposals/<slug>` opens the named-plan preview. **Apply plan** applies its members locally.
- `/proposals/<row IDs>` shares selected published proposals without a named-plan record.
- `/bets/<plan account>` opens the plan's bet, as for proposals.
