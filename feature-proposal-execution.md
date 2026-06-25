# Proposal execution — aligning the engine with the facet UI

The create-proposal dialog now captures clean orthogonal intent (Land use / Parcels /
Ownership recipient / sell) — see [`feature-proposal-goals.md`](./feature-proposal-goals.md).
This is the plan to make that intent actually **execute**, sorted **smaller wins → bigger hauls**.

## The gap (grounded)

Execution is **entirely client-side**. Three layers exist; only the first mutates anything:

1. **Client model** (`proposals.js` + `proposal-manager.js`) — the real engine. Mutates
   in-memory feature collections + `PersistentStorage`.
2. **Backend** (`backend/routes/proposals.js`) — persistence/sharing only (JSONB rows). No
   execution, no ownership column beyond `owner_acceptances`.
3. **On-chain** (`ProposalNFT.sol`) — optional escrow that **pays the accepting owner**; it
   never transfers a title (ParcelNFT is **soulbound**), so "recipient" on-chain = seller.

**Critical fact:** `facets`, `ownershipTransferProposal.recipient/recipientScope/recipientAddress`
are **written by the dialog but never read by any applier** (`grep` in `proposal-manager.js`
returns nothing). They round-trip to the DB and are ignored at execution.

**Two ownership systems exist:**
- **Authoritative:** `parcel_<id>_owner` (agent id) — mutated only by
  `transferParcelOwnership(parcelId, from, to)` (`agents.js:334`). **Zero callers from
  proposals**; only `game.js` seeds it.
- **Cosmetic:** `feature.properties.ownershipDetails.owners` (name/label/percent) — what every
  applier writes today. "City" exists only as a **label** (`ownership-type.js:120`); there is
  **no city agent id**.

So most primitives exist; they're just not connected. The work is mostly *wiring*, with two
genuine design forks (cross-client persistence; on-chain/soulbound reconciliation).

---

## Tier 0 — Foundations (tiny, prerequisites)

| # | Item | Change | Files |
|---|---|---|---|
| 0.1 | **City agent** | Define `CITY_AGENT_ID` and seed one city agent in `agentStorage` (so "to city" has a real owner id, not just a label). | `agents.js`, `game.js` seeding |
| 0.2 | **Recipient resolver** | `resolveProposalRecipientAgentId(proposal)` → `to-me`=current user, `to-city`=city agent, `third-party`+specific=find-or-create an agent for `recipientAddress`. | new helper (`agents.js`/`proposal-manager.js`) |
| 0.3 | **Execution reads facets** | One chokepoint, after a proposal flips to Executed (`proposals.js:25284`, post-`autoApplyExecutedProposalToMap`), that performs ownership transfers per `proposal.ownershipTransferProposal` / `facets.ownership`. | `proposals.js` execute block |

Tier 0 ships no user-visible behavior on its own; it's the spine for Tier 1.

---

## Tier 1 — Small wins: local ownership actually moves (highest leverage)

Each is "call the primitive that already exists from the place that already runs on execute."

| # | Enables | Change | Files |
|---|---|---|---|
| 1.1 | **Directed transfer** (To me / To city / Third-party·Specific) — "buy this lot", "transfer/donate to city" | In the execute block, loop `parentParcelIds` → `transferParcelOwnership(id, current, resolveRecipient(proposal))`. **The single biggest win.** | `proposals.js:25275` + 0.2 |
| 1.2 | **Public good → city-owned** (Park/Square/Lake/Road) | On execute, transfer the parcels (or the merged child) to the city agent. Reuses 1.1. | execute hook / `_applyStructureProposal` |
| 1.3 | **Merge assigns the right owner** | `_applyDecideLaterProposal` currently hard-codes the merged child to the **author** (`proposal-manager.js:3245`). Assign to the resolved recipient instead. | `proposal-manager.js:3245` |
| 1.4 | **Readjust per-slice authoritative owners** | The applier already reads `slice.ownerKey`/`percent` into labels (`proposal-manager.js:3403-3437`); after child ids are assigned (`:3450`), also write `parcel_<id>_owner` per child. Data is already present — only the transfer call is missing. | `proposal-manager.js:3450` |

**Smallest credible PR:** Tier 0 + 1.1 → directed transfers execute in the model. That alone
makes "buy this lot", "transfer to city", and the Specific-address transfer real on the map.

---

## Tier 2 — Medium: the sale flow, recipient consent, persistence

| # | Enables | Change | Notes |
|---|---|---|---|
| 2.1 | **Open sale** (Third party · Anyone) | The from-me path parks at `accepted-not-funded` with `funded:false` and **can never execute** (dead-end badge, `proposals.js:14838`/`25274`). Add a **buyer "claim offer" action** → set `recipientAddress`=buyer, flip to a directed transfer, run 1.1. | Needs a new user action + buyer resolution. Real payment is a separate (Tier 3) piece; a local stub transfer is the minimal "it executes". |
| 2.2 | **Recipient consent** (no force-gift) | Require the named recipient (city/third-party) to **accept** before execution — extend the `ownerAcceptances` gating in `acceptProposal` to include a recipient slot. | Local mirror of the on-chain "recipient must accept" trust lever. |
| 2.3 | **Cross-client persistence of ownership** | `parcel_<id>_owner` is **browser-local only** — transfers don't survive other users/reload. Add an ownership/transfer store server-side (new table + route) + write-through from `transferParcelOwnership`. | This is the literal "backend" gap: today the backend has **no ownership table**, only `owner_acceptances` JSONB. Required for a believable multi-user demo. |

---

## Tier 3 — Big hauls: on-chain + trust model

These need design decisions, not just wiring.

| # | Item | The haul |
|---|---|---|
| 3.0 | **Decide the canonical owner** | Local `parcel_<id>_owner` vs EAS attestation vs (soulbound) ParcelNFT holder. Pick one source of truth before any on-chain work. Tier 1 implicitly picks the local store; on-chain must reconcile. **Design fork — do this first of Tier 3.** |
| 3.1 | **On-chain title transfer ≠ NFT move** | ParcelNFT is **soulbound**; ownership is EAS-attested. So an on-chain transfer = issue a **new owner-list attestation** naming the recipient, not `transferFrom`. Wire execution to emit/replace that attestation. | 
| 3.2 | **Recipient-as-required-accepter on-chain** | `ProposalNFT.acceptProposal` requires **owners** only (`_validateOwnershipAttestations:551`). Add the recipient's attestation/consent as a gate. Contract + EAS schema change. |
| 3.3 | **Sale settlement on-chain** | Today `mintAndFund`→`_distributeFunds` is **proposer-pays-owner** (a subsidy/offer), the *inverse* of a sale. A real sale needs buyer-funds→owner-paid→ownership-attestation-moved. Repurpose or add a contract path. |
| 3.4 | **Covenant / bound use** | Attest the use ("must remain a park") on the output parcel and **enforce** it on future change-of-use proposals (in-app constraint) + carry it as cryptographic evidence. Biggest; pure Phase-3. |

---

## Recommended sequencing

1. **Tier 0 + 1.1** — directed transfers execute locally. Demo-credible, ~1 focused change.
2. **1.2–1.4** — public-good→city, merge owner, per-slice owners. Rounds out the common combos.
3. **2.3** — persist ownership server-side (otherwise everything above is per-browser only).
4. **2.1 / 2.2** — sale buyer flow + recipient consent.
5. **Tier 3** — only after 3.0 (decide the canonical owner); it gates all on-chain work.

Guiding rule: **don't add more facet richness to the dialog until at least Tier 1 lands** —
the value now is closing the gap between captured intent and what actually happens, not
capturing more intent that also won't execute.

---

## Implementation status — Tiers 0–2

**Tier 0 (done)** — `agents.js`: `CITY_AGENT_ID` + `getOrCreateCityAgent()`, `findAgentByName`,
`getOrCreateAgentForRecipient`, `resolveProposalRecipientAgentId(proposal)`.

**Tier 1 (done)** — ownership now actually moves on execution:
- 1.1/1.2 chokepoint `applyProposalOwnershipTransfer(proposal)` (`proposals.js`), called from the
  execute block — transfers `parentParcelIds` to the resolved recipient for every goal except
  merge/readjust (covers directed transfers + public-good→city).
- 1.3 merge: `_applyDecideLaterProposal` assigns the merged child to the recipient (`proposal-manager.js`).
- 1.4 readjust: per-slice `transferParcelOwnership` from the plan's `ownerKey`/`displayName`.

**Tier 2 (done):**
- 2.3 ownership cache: backend `routes/parcel-ownership.js` (self-ensures table; `POST`/`GET
  /parcel-ownership`), registered in `index.js`; `agents.js` write-through `persistParcelOwnership`.
  **Non-canonical by design** — canonical ownership is on-chain (pulled on request); this is a
  best-effort display/game cache, deliberately **not** auto-hydrated (that would override chain truth).
- 2.1 sale: `claimSaleOffer(proposalId, buyerAgentId)` binds a buyer and transfers the parcels.
  **Buy button** (`isProposalOpenSaleOffer` gate) in the proposal **list rows**
  (`buildProposalActionButtons`) and the **details dialog** (`primaryActionsHtml`); minted cards
  reach it via their Details → dialog.
- 2.2 consent: `proposalRecipientConsentSatisfied` gates execution; opt-in via
  `window.PROPOSAL_REQUIRE_RECIPIENT_CONSENT`. The **recipient appears as the first line item in the
  per-parcel owner-acceptance list** (`buildOwnerAcceptanceSectionHtml`) with its own Accept
  (`acceptAsRecipient` → `recordRecipientConsent`).

**Not yet verified in-browser.** Syntax-checked; backend tests pass (486). Tier 3 (on-chain /
canonical ownership, sale settlement, covenants) remains. Buy/recipient button strings use English
fallbacks (t() default) — localize when convenient.
