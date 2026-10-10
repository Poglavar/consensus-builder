<!-- Design of record for named plans: immutable named sets of proposals, and betting on them. -->

# Plans

A **proposal** is the building block (one building, one park, one street network, one parcel
layout). A **plan** is a named, ordered set of proposals: what people actually argue and bet
about ("the official UPU Borovje", "Borovje – urban blocks"). Decisions of 2026-10-10.

## A named plan never changes

- `POST /plans` creates a plan. There is no update route: no `PUT`, no edit token.
- A revision is a new plan with a new name. The convention is `<name>-v2`, `-v3`, …; a taken
  name answers 409 with the next free `-vN` as `suggestion`.
- A revision records `supersedes: <old slug>`. The old plan is not touched; its page learns of
  the newer version by looking up who supersedes it (`supersededBy`, computed on read).
- There is no "latest" alias. A name that moves is exactly what this design removes.
- Title, description and author are fixed with the plan. A typo is a `-v2`.
- The 21 named plans that existed before this change (none was ever edited) are frozen as they are.

## A plan is only as fixed as its members

Proposal rows can still be repaired in place by operator scripts (as the 2026-10-10 Borovje
sync did). So a plan stores, at creation:

- `member_hashes` — per member, the sha256 of **what it builds**: goal, type, declared parcels,
  the road definition, building/structure parameters and geometry, the parcel layout polygons
  (`backend/plans/plan-hash.js`). Descriptions, thumbnails and lifecycle state are
  not part of it, so they can change without touching the plan.
- `plan_hash` — sha256 over the ordered `[proposalId, memberHash]` list.
- `site` — the union of the members' sites, for the on-chain mint.

`GET /plans/:slug` recomputes each member's hash and reports `changed: true` for any member
that no longer matches. A repaired member therefore shows up instead of silently changing a
plan people bet on. Rule for repairs: once a proposal belongs to a minted plan, a repair makes
new rows and a new plan version; it does not edit the rows in place.

## Betting on a plan

One plan → one on-chain proposal account → one `proposal_market` pool. No program changes:

- `scripts/mint-plan.mjs` mints a site-only proposal account for the plan (site = the plan's
  site, `image_uri` = `ugt-plan:<slug>@<plan_hash>`, so the account commits to the exact
  content) and records it on the plan row (`onchain_data`).
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

The plan hash is over members' stable `proposal_id`s and what they build, so the same plan named in
two databases hashes equal — one devnet mint can then be recorded in both
(`mint-plan.mjs --record-existing`, which checks the account's `image_uri` on chain first). The
stored `site` is deliberately not hashed: PostGIS versions return the same union with different
vertex order.

## Links

- `/proposals/<slug>` opens a plan (applies its members), as before.
- `/bets/<plan account>` opens the plan's bet, as for proposals.
