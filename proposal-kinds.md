# Proposal kinds: owner deal, owner vote, community vote

Plan for making the app usable by NGOs and neighbourhood organisers: who decides a proposal and
whether it binds becomes a choice made at publish time, and a community vote whose result an NGO
reports, signed with a wallet its own website lists. Written 2026-10-17 after the live organiser
UX audit; living document, update it as milestones finish.

## Vocabulary

- **Design**: what the proposal changes on the map (park, square, road, track, readjustment,
  subdivision, sale of a parcel…). Drawing a design is local and needs no kind.
- **Kind**: who decides and whether it binds. Chosen only when a record is published (uploaded or
  minted), stored as metadata. Any design can have any kind.

| Kind | Who decides | Binding | Money | Today |
|---|---|---|---|---|
| **Owner deal** | parcel owners accept | yes | offer/escrow | the default path |
| **Owner vote** | parcel owners vote | no | none | inferred from the design, EVM only |
| **Community vote** | residents, counted by an NGO that reports the result | no | none | does not exist |

Owner deal has two directions:

- **Offer to owners**: the proposer offers, the owners accept, the proposer funds.
- **Owner's sale offer**: the owner offers their own parcels; the owner's acceptance is recorded at
  creation, a buyer funds it (today's `ownership-transfer-from-me`, `create.js:1073`,
  `isProposalOpenSaleOffer` in `lifecycle.js:10`). Keeps its reduced terms (expiry only).

## Decisions (user, 2026-10-17)

1. Three kinds as above; all three work with any design. They differ only in publish metadata and
   the badges on lists and details, never in what can be drawn.
2. Local drawing never asks for a kind. Only publish/mint sets the kind and its details.
3. The platform takes no position on who is a resident. The NGO collects votes its own way and
   reports the result; the app shows who reported it.
4. The NGO is identified by a website it controls, using the existing `did:web` standard rather
   than a protocol of our own.
5. A shareable proposal page comes before any notification system; "Follow this proposal" with an
   email digest comes later, once proposals are getting support.
6. The owner's sale offer must keep working under the new kinds.
7. Every record that leaves the device carries a kind, whether shared (uploaded) or minted. The
   publish step preselects **Community vote** as the least-committal kind, and its result reporter
   is optional, so sharing just a design ("here is an idea") is publishing with the default.
8. Solana first, then EVM. Changing the contracts/programs on either chain is allowed when needed.
9. The proposer has a wallet, signs, mints and pays. On devnet/testnet the platform sponsors the
   cost for demos, on both chains.
10. The platform stays agnostic about how an NGO runs its vote and shows as little of the result as
    makes sense: no counts, methods or periods in our schema, so we are never part of a dispute
    about procedure. The NGO's own page carries the detail.
11. Backfilling `kind` onto existing server rows: agreed, then dropped (2026-10-17, during M1).
    Prod holds no real votes (0 of 663 rows set `isVote`; the 5 the old inference called votes are
    July "Urban Rule" test records with offers), and writing `kind` into a published record would
    move its consent hash, which owners' signed decisions bind to. A record without a kind reads as
    an owner deal instead (`ProposalKind.kindOf`).

## What changes in the model

**Today** the vote kind is inferred, not chosen: `isVoteProposal` (`frontend/js/proposals/lifecycle.js:262`)
and the create path (`create.js:937`) treat a proposal as a vote only when it changes no ownership and
no parcels (`facets.ownership === 'no-change' && facets.parcels === 'as-is'`). So a park drawn over a
car park's parcel can never be a vote; it is forced into the binding path and gets a random offer
(`dialog-create.js:1498`, 1 to 1,000,000).

**New**: `proposal.kind` ∈ `owner-deal` | `owner-vote` | `community-vote`, plus `owner-deal`'s
`direction` (`to-owners` | `owner-sale`). Rules:

- `isVoteProposal` reads `kind` only; the facet inference is removed (no fallback path).
- The kind is part of the published commitment (consent/effect hash): an owner who accepted a
  binding deal can never see it turn into a vote. Changing the kind of a published record is a new
  proposal (fork), like any other edit of a published record.
- Validation per kind: owner and community votes carry no offer, deposit, budget or escrow; owner
  deal needs terms; owner's sale offer needs the proposer to be the owner of every parcel.
- Local drafts have no kind. A draft is published through the kind step, which preselects
  Community vote (decision 7).
- A community vote without a result reporter is valid: it is a shared design that asks for
  nothing binding and shows no result.

## The publish step (UI)

One page: the existing create/edit proposal dialog, with the kind chosen first. Not a multi-step
wizard, because there is one decision and everything after it is a short form. The same dialog
already edits existing proposals, and stepping through screens to reach one field makes editing
slow and hides validation errors on screens already left.

```
┌ Publish proposal ───────────────────────────────────────┐
│ Who decides?                                            │
│ [ Owner deal ]  [ Owner vote ]  [●Community vote ]      │
│   └ Offer to owners · Owner's sale offer                │
│ Title, description            (all kinds)               │
│ Parcels / site                (all kinds, read-only)    │
│ Terms: offer, deposit, expiry (owner deal only)         │
│ Voting deadline (days)        (both votes)              │
│ Result reported by: did:web   (community vote, optional)│
│ Where people take part: URL   (community vote, optional)│
│                                                         │
│ "You are asking residents of this area for non-binding  │
│  support. Nothing is paid and no one's land changes."   │
│                                         [ Publish ]     │
└─────────────────────────────────────────────────────────┘
```

- No money anywhere unless Owner deal is chosen; the random offer prefill goes. Durations are in
  days, not milliseconds.
- The summary line above Publish is written from the kind and the design: what is asked, of whom,
  whether it binds, whether money moves.
- Entry points that publish and must go through the kind step: the create dialog submit
  (`create.js:1936`–`1976`, mint per chain), the upload dialog (`dialog-upload.js:1132`), and Share
  (`sharing-routes.js` `shareSingleProposal`, `shareAppliedProposals`).
- Badges: a kind badge on proposal list rows, details and the share page; "Owner deal" also shows
  its direction.

## Community vote result

### Who may report: `did:web`

The NGO enters a `did:web` identifier (or just its domain, which we turn into one). We recommend a
purpose-specific path DID so the document only serves this use:

| DID | Document fetched |
|---|---|
| `did:web:greenzagreb.org` | `https://greenzagreb.org/.well-known/did.json` |
| `did:web:greenzagreb.org:urbangametheory` (recommended) | `https://greenzagreb.org/urbangametheory/did.json` |

The document lists the NGO's wallets as verification methods with a CAIP-10 `blockchainAccountId`,
referenced from `assertionMethod` (allowed to make statements):

```json
{
  "@context": ["https://www.w3.org/ns/did/v1"],
  "id": "did:web:greenzagreb.org:urbangametheory",
  "verificationMethod": [{
    "id": "did:web:greenzagreb.org:urbangametheory#solana-1",
    "type": "Ed25519VerificationKey2020",
    "controller": "did:web:greenzagreb.org:urbangametheory",
    "blockchainAccountId": "solana:<cluster genesis hash>:<address>"
  }],
  "assertionMethod": ["did:web:greenzagreb.org:urbangametheory#solana-1"]
}
```

Verify the exact verification-method type names and the CAIP-2 Solana cluster ids against the
`did:web` and `did:pkh`/CAIP specs when implementing.

- **Two-way binding**: the proposal metadata names the DID, and the DID document lists the wallet.
  A result counts only if its signer is listed in `assertionMethod` of the DID the proposal named.
- **Fetched by the browser**, so it works without our server. The NGO's host must send
  `Access-Control-Allow-Origin: *` on the file. If a host cannot, relaying through our server
  needs the user's yes first.
- **Hosts that cannot serve files** (some Wix/Squarespace plans) can use any static host they
  control (e.g. GitHub Pages); the badge then shows that host. No DNS-record fallback: there is no
  widely used standard for it.
- **What the badge means**: "✓ greenzagreb.org: this site lists the wallet that reported the
  result", re-checked live. It goes grey if the site later removes the wallet. It does not say the
  NGO is legitimate or the count is honest; the copy next to the badge says so.

### The result itself

A JSON document `community-result/v1` pinned to IPFS. Deliberately minimal (decision 10): we carry
the NGO's own one-line statement and a link to its page, and never parse, tally or judge counts,
methods or eligibility.

```json
{ "schema": "community-result/v1", "proposal": "<chain>:<proposal account or id>",
  "attester": "did:web:greenzagreb.org:urbangametheory",
  "statement": "Residents back the park: 312 for, 41 against.",
  "url": "https://greenzagreb.org/park-vote",
  "didDocumentSha256": "<hash of did.json when posted>",
  "postedAt": "2026-11-16T10:00:00Z" }
```

`statement` is plain text with a length cap (around 280 characters), shown as the NGO's words,
attributed: *"greenzagreb.org ✓ says: …"*. `url` is optional.

- **Solana**: anchored the way owner decisions already are (`frontend/js/proposals/approval-anchor.js`):
  a Memo v1 transaction from the NGO's wallet recording
  `ugt-community-result/1 <proposal account> <ipfs uri> sha256:<hash>` with a lookup address
  derived from the proposal account. The transaction signature is the NGO's signature; no program
  change. A reader lists the memos, fetches each document, checks its hash and the signer against
  the DID document.
- **EVM**: an EAS attestation (the contract already uses EAS) with a `CommunityResult` schema
  carrying the IPFS URI and hash; no contract change.
- The NGO can post again as the count grows; the newest valid result per attester is shown, older
  ones stay visible as history.

## Shareable proposal page

The link an NGO sends through its own channels (newsletter, WhatsApp, Facebook):

- `/proposals/:id` already unfurls through the `og-proposals` Cloudflare Worker
  (`workers/og-proposals/`, built from `OG-IMAGE-PLAN.md`): proposal image, title and description.
  M5 extends its description with the kind and the plain-language summary rather than adding a
  second preview path.
- The page shows: plain-language summary (what changes, who asks, kind, deadline), before/after
  pictures (the existing dividers work, `dividers.md`), the kind badge, and for a community vote
  the latest reported statement and one button, "Take part", linking to the NGO's own URL.

## Paying for publishing

The proposer's wallet signs and pays, as every Solana write does today (`feePayer: wallet` across
`frontend/js/solana/*`). There is no sponsorship yet. For devnet/testnet demos, the simplest
sponsorship that keeps the proposer as the signer on the record is a rate-limited drip: a server
demo wallet sends devnet SOL (and testnet ETH for EVM) to a proposer's wallet that is short of the
mint cost, then the proposer mints as usual. A co-signing fee payer (Solana) or paymaster (EVM)
would hide the cost entirely but is more machinery; only if the drip proves too clumsy. Never on
mainnet.

## Milestones

| # | Milestone | Main files | Tests |
|---|---|---|---|
| M0 | Wording: "ownership not established", no-cadastre status, "Local road draft created" | i18n ×4, `site-drawing.js`, `road-drawing.js` | done, `cc349880` |
| M1 status | Built 2026-10-17: `proposals/proposal-kind.js`; kind row in both create dialogs (community vote preselected; deal/vote terms by CSS); random offer prefills removed; votes store no money and run to a day-count deadline; owner vote refused on Solana until M3; server and chain record refuse a vote with money; kind badges | | see the M1 commit |
| M1 | `kind` in the model: validation, hash commitment, `isVoteProposal` reads `kind`, facet inference removed, badges | `lifecycle.js`, `create.js`, consent/effect hash, list/details UI | unit: each kind × design (a park over a taken parcel can be either vote kind); owner's sale offer stays an open sale offer, never a vote; changing kind changes the hash |
| M2 | Publish step: kind cards in the create dialog, per-kind sections, no random offer, days not ms, summary line; all publish entry points go through it | `dialog-create.js`, `create.js`, `dialog-upload.js`, `sharing-routes.js` | unit for the summary text and per-kind validation; targeted headless Playwright spec for the kind step |
| M2 status | Built 2026-10-17 as one draft → publish flow: dead parks/squares dialog deleted (`71fdd4bd`); one terms builder `proposals/publish-terms.js`, no placeholder offer (`9e87edd5`); one mint `proposals/publish-mint.js` for both dialogs, mirrored to the server after every mint (`0e0fdd3d`); Share on a local proposal without terms opens the create dialog first, Share entire plan asks the kind once (`a28d4980`). The create dialog is the publish step; no separate panel. | | |
| M2 tests | Browser specs (headless Playwright): Share on a quick drawing goes through the create dialog and uploads the record it saved with its kind; Share entire plan uploads every member under the one kind it asks; the share dialog mints an owner deal with its escrow and a community vote fund-less with its deadline (stubbed EVM bridge); the create dialog mints a community vote on Solana (stubbed bridge) and the share dialog then shows the minted record; an owner's offer of their land locks the kind row to owner deal. A fork or edit now starts from its source's kind (`ProposalPublishTerms.chosenKind`: its own kind, owner deal for a published record without one, nothing for a local drawing). | `chain-mint-independence.spec.ts`, `proposals-sharing.spec.ts`, `proposal-form-controls.spec.ts`; helpers `chooseTermsForShare`, `chooseProposalKind` | |
| M2 publish in place | Built 2026-10-17 (user: "on mint or publish nothing should be recreated"). Share on a local record whose terms were never chosen opens the create dialog in its terms mode (`data-publish-in-place`: design, site and parcel summary hidden; "Before publishing" / "Save terms"); saving appends kind, terms, name, description, author, epoch and the current lens to that same record (`ProposalPublishTerms.termsInPlace`, `create.js publishTermsInPlace`), then the share dialog uploads or mints it. The share dialog mints on whichever chain is connected, Solana included (`ProposalPublishMint.connectedChain`; Solana checks parcel anchors). Offers take fractions in the UI language (`CbFormat.parseDecimal`; regrouped when the field is left). | `create.js`, `dialog-create.js`, `dialog-upload.js`, `publish-terms.js`, `publish-mint.js`, `format.js`, `lifecycle.js` | unit: parseDecimal, termsInPlace, Share gate; headless Playwright: Share on a drawing keeps its id, half-ETH owner deal minted on EVM, community vote minted on Solana, track Share |
| M3 | Owner vote on Solana (today the Solana bridge has no `castVote`, so owner votes exist only on EVM) | `solana/proposal-bridge.js`; reuse `proposal-approval/v1` + memo anchors marked non-binding, if it fits | unit on the reader/tally |
| M4 | Community vote: `did:web` resolver (pure parse module + thin fetch), optional attester field, result document, Solana memo anchor first, EAS on EVM second, badge | new `frontend/js/proposals/did-web.js`, `community-result.js` | unit: DID→URL mapping, CAIP-10 matching, signer not listed → rejected, wallet removed → grey, tampered document → hash fails, over-long statement → refused |
| M5 | Shareable proposal page: kind and summary in the existing `og-proposals` preview, "Take part" link in the app | `workers/og-proposals/`, details panel | Worker unit test for the description |
| M6 | Devnet/testnet drip so demo proposers can mint | backend route + demo wallet, rate limit per wallet/IP | unit on the limiter; refuses on a mainnet cluster |
| ~~M7~~ | Backfill dropped, see decision 11 | | |

Later, not in this plan: "Follow this proposal / this area" with an email digest; keeping the map
preview's parcels as provisional when the server has no cadastre (audit O2, second half); labelling
mock road costs and TEAD (audit O3).

## Open questions

The five from the first draft were answered 2026-10-17 (decisions 7–11).

1. ~~Should a community vote carry an owner approval setup?~~ Answered 2026-10-17 (user: no).
   Every record published from an editor draft used to get the default approval setup, which
   only Solana mints, so Share sent every quick drawing down a path EVM refuses and that escrows
   nothing on Solana. Now `ProposalPublishTerms.approvalSetupFor` decides: a community vote has
   none; an owner deal or owner vote only the setup its author set in the Approval tab; a land
   readjustment keeps its setup whatever the kind (its rights snapshot also says who owns which
   plot), with the default when published from a draft without one.
