# Purchase and sale offers

A standalone `property-offer/v1` names one whole X-ray apartment or a bundle of source-qualified parcels, a fixed price in SOL, a deadline and the maker’s chosen lens. A bid opens the seller role. A listing opens the buyer role.

## Apartment offers

From the selected apartment in **X-ray**, choose **Offer to buy apartment** or **Offer to sell apartment**. The same actions appear under **Independent offers in SOL** on the apartment row of an open funding agreement. Enter the price, select a lens, and mint the offer. A seller specifies the payout schedule. A buyer’s offer receives its schedule at acceptance.

The mint transaction creates the offer and creates or reuses the apartment’s ownerless address. Every offer for the same X-ray building and unit shares that address. Anyone can pay the creation cost. The address stays fixed when a different wallet proposes an offer or a sale settles. The proposer’s lens sets the qualification criteria for the other party.

**Find apartment offers** in X-ray lists live standalone bids and listings and also finds USDC reservation agreements for the same unit. The USDC link opens the developer’s agreement with the unit selected. Its deposit and contract stay with that agreement. [Developer crowdfunding](developer-crowdfunding.md)

For a standalone offer, **Share acceptance link** shares the parties and the exact payout schedule for review. The reference lens operator approves them with `POST /lens/property-offers/:cid/qualify`, an operator token, and `{buyer, seller, payouts}`. The counterparty signs **Accept offer**. The lens returns its existing approval for that exact offer, buyer, seller and payouts. The buyer can then fund the price, and execution pays the agreed recipients. Another wallet, changed terms, an expired approval or an unrelated lens cannot authorize acceptance.

## Parcel offer workflow

1. Select one parcel or a parcel set. In its **Actions → Ownership** group, choose **Offer to buy**
   or **Offer to sell**. Connect the proposer’s Solana wallet, enter total SOL price, deadline and
   the ownership lens. A sale includes an explicit payout schedule totaling the price.
2. Select **Mint offer**. This publishes the exact terms and requests the Solana mint in one action.
   Before publishing, the browser verifies the network/program, the live lens service, its registered
   active SAS credential/schema and complete ownership coverage. A sale must name an owner as proposer
   and pay the exact owner union. A preflight failure leaves the form editable. If a later mint fails
   or the wallet declines, the published offer remains available for retry without changing its terms.
   Publication alone does not create an on-chain offer or escrow.
3. Find the offer in **Lists → Agreements**. Share opens `/property-offers/<cid>`; Download exports
   the canonical JSON and the Agreements import accepts it. An imported or unfinished offer uses
   the same **Mint offer** action to complete publication and minting.
4. Open **Accept offer** to prepare the parties and payments. A buy offer obtains its payout schedule
   here; a sale retains its published schedule. Each payout recipient signs **Sign my seller consent**
   with their own wallet. The signature names the buyer, exact offer, payout and current ownership
   evidence. It authorizes transfer upon finalized settlement. **Share acceptance link** creates one immutable shared candidate using a
   participant-signed request; other sellers open that link, review and sign. **Refresh signatures**
   collects their independently stored consents and shows which wallets are still needed. Acceptance
   refreshes signatures before submitting to the lens. JSON download/import remains available.
   Changing parties, the payment schedule or the ownership evidence starts a different candidate and clears prior consents.
5. The accepting counterparty submits **Accept offer**: the buyer for a sale, or the seller
   representative for a buy. The lens independently reads the offer, its open chain account and the
   complete source-qualified owner sets. It verifies every owner signature and the counterparty’s
   signed request, then issues a SAS `PropertyOfferDecision` attestation. Acceptance records this
   exact decision atomically on Solana.
6. The bound buyer selects **Fund**, depositing exactly the price. **Execute** pays all scheduled
   recipients atomically. An open offer can be cancelled by its proposer. After acceptance it can
   execute before the deadline or expire afterward; expiration refunds escrow to the bound buyer.

The review panel lists exact parcel references with map navigation, full buyer/seller wallets,
payout recipients and amounts, and the Solana account. Refresh can recover a confirmed account whose
index update failed; changing the connected wallet updates the available actions.

Parcel anchors remain ownerless and non-transferable; registered title comes from the land registry.
After finalized payment the offer lens publishes the seller-signed `parcel-ownership-transfer/v1`
evidence at `GET /lens/property-offers/:cid/transfer`. The record includes the offer and Solana network,
prior ownership evidence for each source-qualified parcel, the buyer, every outgoing owner’s signature,
the decision attestation, and the finalized account’s observation time. A predecessor from an earlier
sale identifies that sale’s lens and offer CID so another lens can retrieve and verify the link.

The reference lens follows these transfers from its configured ownership roots. It verifies the
current predecessor set before authorizing an offer and reserves those predecessors within its own
lens and network while settlement is pending. A finalized cancellation or expiry releases the
reservation. Final settlement recognizes the buyer as the successor for each parcel in the bundle.
Parcel offers and land agreements using this reference lens resolve ownership through the same evidence chain.
Other lenses can verify the published evidence against the roots and issuers they trust.

## Identity and persistence

The CID commits canonical immutable terms: direction, proposer, open counterparty role, city,
creation and expiry, lens, exact property and whole-lamport price. The property is either `parcels` or one `apartment` with `xrayBuilding`, `unit`, `at` and optional estimated-layout `access`. The apartment PDA uses the seeds `"apartment"` and the SHA-256 of the UTF-8 JSON array `["apartment/v1", xrayBuilding, unit]` under the parcel anchor program. Camera, terms, developer and payer are outside its identity. Sell terms
also commit sorted payout rows. There are at most 200 distinct parcels and 16 distinct recipients;
amounts are positive u64 decimal strings and the payout sum must equal the price exactly.

`consensus.property_offer` holds published terms separately from plan agreements. Local working
copies use the `property-offer:` storage prefix. Accepted counterparties and chain state are separate
from the immutable content. `consensus.property_offer_acceptance` stores up to 32 distinct shared
candidates per offer, keyed by the SHA-256 of canonical terms including parties and payout schedule.
Sharing requires a signed request by a candidate party. For a parcel bundle, the service verifies
and merges each seller’s signature, and the parcel lens checks the owner set. For an apartment,
the chosen lens qualifies the counterparty for the shared terms. Expired sessions remain readable but cannot
collect new signatures. `/property-offers/:cid/onchain` independently reads the expected Solana
PDA and checks its program, CID, terms hash, maker, lens, direction, price, deadline and sale payouts
before mirroring state; browser status claims are never accepted as evidence.

Whole-building offers would need their own building-scoped identity. The current standalone asset choices are apartments and parcel bundles.

## Solana and lens runtime

The new program is `blockchain/solana/programs/property_offer`, with browser codec
`frontend/js/solana/property-offer-client.js`. Its configured address is
`BasWrJJH6By9nkeeLAoAdYpPu35BM9VMtMCWGyXjqdBp`. This source configuration is not a statement that the
program is deployed on devnet. The bridge checks deployment at runtime. The existing `agreement`
program remains the program for plan agreements.

The SAS schema is `PropertyOfferDecision` v2. It binds the offer CID and account, canonical terms hash,
ordered payout hash, buyer, seller, affirmative counterparty qualification and observation time. The
[program contract](../blockchain/solana/programs/property_offer/README.md) defines its byte layout.

The lens serves `POST /lens/property-offers/check` for pre-mint schema and policy configuration
checks and `POST /lens/property-offers/:cid/decision` for approval, with bounded request rates. Requests
supply proposed parties, payouts and the accepting wallet’s signed request. For parcel bundles
the request also carries the sellers’ signatures.
The server derives truth fields itself. `lens/run.mjs` supplies the database index and RPC readers.
The reference identity adapter uses the explicitly configured devnet registry. Current `oss-wfs`
references with official `HR-*` IDs map to that registry’s existing raw cadastral IDs. Every other
source or snapshot uses the canonical JSON array `[sourceId, parcelId, snapshotIdOrNull]`; there is
no fallback to a bare ID. Returned owner sets are keyed by the offer’s canonical reference. All rows of a
parcel must agree on the complete owner count, and every owner must be a payout recipient and sign.
The reference parcel policy requires an identity adapter with complete owner-set reads. The apartment policy requires the selected lens’s explicit qualification. Registry
`establishedAt` records source provenance, not a claim of a new live registry observation.

Apply `db/property-offer-ddl.sql` and the updated `routes/lens-member-ddl.sql` with the usual backend
DDL process. A live lens needs the registered SAS schema `PropertyOfferDecision-v2`. Its affirmative field is `counterpartyQualified`. A v1 ownership decision cannot authorize a new acceptance. API/bridge devnet
connections verify the devnet genesis hash. Localnet indexing is available only when
`SOLANA_LOCALNET_RPC_URL` explicitly names a loopback endpoint; the browser likewise needs an explicit
`SOLANA_RPC_URLS.localnet`. No public-network deployment or transaction is implicit in local tests.

## MCP editing

`ugt_draft_property_offer`, `ugt_edit_property_offer`, `ugt_list_property_offer`,
`ugt_get_property_offer`, `ugt_prepare_property_offer`, `ugt_consent_property_offer` and
`ugt_publish_property_offer` share the canonical record model.
Edits require the inspected `expectedCid`; publication requires the reviewed CID and `confirm=true`.
Draft content and prepared acceptance packages are portable JSON for browser import. Preparation
returns the accepting-wallet and sharing messages. Parcel offers additionally require the ownership hash and seller consent messages. For apartment discovery, pass `city`, `xrayBuilding` and `unit` together to `ugt_list_property_offer`. The consent tool reads shared sessions
or relays supplied signatures with `confirm=true`. These tools never generate wallet signatures
or send funds. The person completes those steps with their wallet in the browser. The hosted
server therefore offers all seven: publication and consent relays are annotated as
non-destructive public writes, like `ugt_publish_design`, and share its per-minute publish budget.
